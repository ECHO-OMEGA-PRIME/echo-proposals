// Echo Proposals v1.0.0 — AI-powered proposal & quote builder
// Cloudflare Worker: D1 + KV + Service Bindings (Engine Runtime, Shared Brain, Email Sender)

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY: string;
  ENVIRONMENT: string;
  AE: AnalyticsEngineDataset;
}

interface RLState { c: number; t: number }

function sanitize(s: string, max = 5000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function uid(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); }

function slug(): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; const a = new Uint8Array(10); crypto.getRandomValues(a);
  for (const b of a) s += c[b % c.length]; return s;
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Echo-API-Key,X-Tenant-ID');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } }));
}

function err(msg: string, status = 400): Response { return json({ error: msg }, status); }

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-proposals', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

function authOk(req: Request, env: Env): boolean {
  return (req.headers.get('X-Echo-API-Key') || req.headers.get('Authorization')?.replace('Bearer ', '')) === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, max: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`; const raw = await kv.get(k); const now = Date.now();
  if (raw) { const st: RLState = JSON.parse(raw); const elapsed = (now - st.t) / 1000; const decayed = Math.max(0, st.c - (elapsed / windowSec) * max); if (decayed + 1 > max) return false; await kv.put(k, JSON.stringify({ c: decayed + 1, t: now } as RLState), { expirationTtl: windowSec * 2 }); }
  else { await kv.put(k, JSON.stringify({ c: 1, t: now } as RLState), { expirationTtl: windowSec * 2 }); }
  return true;
}

function tenantId(req: Request, url: URL): string {
  return req.headers.get('X-Tenant-ID') || url.searchParams.get('tenant_id') || '';
}

function calcTotal(items: any[], discountType?: string, discountValue?: number, taxRate?: number): { subtotal: number; total: number } {
  const subtotal = (items || []).reduce((s: number, i: any) => s + (i.quantity || 1) * (i.unit_price || 0), 0);
  let afterDiscount = subtotal;
  if (discountType === 'fixed') afterDiscount = subtotal - (discountValue || 0);
  else if (discountType === 'percent') afterDiscount = subtotal * (1 - (discountValue || 0) / 100);
  const total = afterDiscount * (1 + (taxRate || 0) / 100);
  return { subtotal: Math.round(subtotal * 100) / 100, total: Math.round(total * 100) / 100 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try { env.AE.writeDataPoint({ blobs: [m, p, '200'], doubles: [Date.now()], indexes: ['echo-proposals'] }); } catch {}

    try {
      // ── Public ──
      if (p === '/health') return json({ status: 'ok', service: 'echo-proposals', version: '1.0.0', timestamp: new Date().toISOString() });

      // Public: view proposal
      if (p.startsWith('/p/') && m === 'GET') {
        const propSlug = p.slice(3);
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (!await rateLimit(env.CACHE, `view:${ip}`, 30, 60)) return err('Rate limited', 429);
        const proposal = await env.DB.prepare(
          `SELECT p.*, c.name as client_name, c.company as client_company, c.email as client_email,
           t.name as tenant_name, t.logo_url, t.brand_color, t.email as tenant_email, t.phone as tenant_phone, t.website as tenant_website, t.address as tenant_address
           FROM proposals p JOIN tenants t ON t.id = p.tenant_id LEFT JOIN clients c ON c.id = p.client_id WHERE p.slug = ? AND p.status NOT IN ('draft')`
        ).bind(propSlug).first();
        if (!proposal) return cors(new Response('Proposal not found.', { status: 404, headers: { 'Content-Type': 'text/html' } }));
        // Track view
        await env.DB.prepare('UPDATE proposals SET view_count = view_count + 1, viewed_at = datetime(?), first_viewed_at = COALESCE(first_viewed_at, datetime(?)) WHERE slug = ?').bind('now', 'now', propSlug).run();
        if (proposal.status === 'sent') await env.DB.prepare("UPDATE proposals SET status = 'viewed' WHERE slug = ? AND status = 'sent'").bind(propSlug).run();
        await env.DB.prepare('INSERT INTO proposal_views (proposal_id, viewer_ip, viewer_ua) VALUES (?, ?, ?)').bind(proposal.id, ip, req.headers.get('User-Agent')?.slice(0, 200) || '').run();
        const sections = JSON.parse((proposal.sections as string) || '[]');
        const pricing = JSON.parse((proposal.pricing_table as string) || '[]');
        const bc = proposal.brand_color || '#14b8a6';
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${proposal.title} — ${proposal.tenant_name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:20px}.header{background:${bc};color:#fff;padding:40px;border-radius:16px 16px 0 0;text-align:center}
.header img{max-height:48px;margin-bottom:16px}.header h1{font-size:1.8rem;margin-bottom:8px}.header .meta{opacity:0.9;font-size:0.9rem}
.body{background:#fff;padding:40px;border:1px solid #e2e8f0}.section{margin-bottom:32px}.section h2{font-size:1.3rem;color:${bc};margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid ${bc}20}
.section p,.section li{font-size:0.95rem;color:#475569}.pricing{width:100%;border-collapse:collapse;margin:16px 0}.pricing th{background:${bc}10;color:${bc};text-align:left;padding:10px 12px;font-size:0.85rem}
.pricing td{padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:0.9rem}.pricing .total-row td{font-weight:700;border-top:2px solid ${bc};font-size:1rem}
.footer-bar{background:#fff;padding:24px 40px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;padding:12px 32px;border-radius:8px;font-weight:700;cursor:pointer;text-decoration:none;font-size:0.95rem;border:none}
.btn-accept{background:${bc};color:#fff}.btn-decline{background:#fff;color:#64748b;border:1px solid #cbd5e1}
.terms{font-size:0.85rem;color:#64748b;margin-top:24px;padding:16px;background:#f1f5f9;border-radius:8px}
.comment-box{margin-top:24px;padding:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px}
.comment-box h3{font-size:1rem;margin-bottom:12px}
.comment-box textarea{width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;min-height:80px;font-size:0.9rem;resize:vertical}
.comment-box button{margin-top:8px;padding:8px 20px;background:${bc};color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600}
.sig-area{margin-top:16px;padding:16px;border:2px dashed #cbd5e1;border-radius:8px;text-align:center}
.sig-area canvas{border:1px solid #e2e8f0;border-radius:4px;cursor:crosshair}
#accepted-msg{display:none;text-align:center;padding:32px;color:#22c55e;font-size:1.2rem;font-weight:700}
${proposal.custom_css || ''}
</style></head><body><div class="container">
<div class="header">${proposal.logo_url ? `<img src="${proposal.logo_url}" alt="">` : ''}<h1>${proposal.title}</h1>
<div class="meta">Prepared for ${proposal.client_name || 'Client'}${proposal.client_company ? ` at ${proposal.client_company}` : ''} | ${new Date(proposal.created_at as string).toLocaleDateString()}${proposal.valid_until ? ` | Valid until ${new Date(proposal.valid_until as string).toLocaleDateString()}` : ''}</div></div>
<div class="body">
${sections.map((s: any) => `<div class="section"><h2>${s.title || ''}</h2>${s.type === 'text' ? `<div>${s.content || ''}</div>` : s.type === 'image' ? `<img src="${s.image_url || ''}" alt="" style="max-width:100%;border-radius:8px">` : s.type === 'testimonial' ? `<blockquote style="border-left:3px solid ${bc};padding-left:16px;font-style:italic;color:#64748b">"${s.quote || ''}"<br><strong>${s.author || ''}</strong></blockquote>` : `<div>${s.content || ''}</div>`}</div>`).join('')}
${pricing.length ? `<div class="section"><h2>Pricing</h2><table class="pricing"><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>
${pricing.map((i: any) => `<tr><td>${i.name || ''}<br><small style="color:#64748b">${i.description || ''}</small></td><td>${i.quantity || 1}</td><td>$${(i.unit_price || 0).toLocaleString()}</td><td>$${((i.quantity || 1) * (i.unit_price || 0)).toLocaleString()}</td></tr>`).join('')}
<tr class="total-row"><td colspan="3">Subtotal</td><td>$${proposal.subtotal?.toLocaleString()}</td></tr>
${proposal.discount_value ? `<tr><td colspan="3">Discount${proposal.discount_type === 'percent' ? ` (${proposal.discount_value}%)` : ''}</td><td>-$${(proposal.discount_type === 'percent' ? (proposal.subtotal as number) * (proposal.discount_value as number) / 100 : proposal.discount_value as number).toLocaleString()}</td></tr>` : ''}
${proposal.tax_rate ? `<tr><td colspan="3">Tax (${proposal.tax_rate}%)</td><td>+$${((proposal.total as number) - (proposal.subtotal as number) + (proposal.discount_type === 'percent' ? (proposal.subtotal as number) * (proposal.discount_value as number || 0) / 100 : (proposal.discount_value as number || 0))).toLocaleString()}</td></tr>` : ''}
<tr class="total-row"><td colspan="3">Total</td><td style="font-size:1.2rem;color:${bc}">$${proposal.total?.toLocaleString()}</td></tr></tbody></table></div>` : ''}
${proposal.terms ? `<div class="terms"><strong>Terms & Conditions</strong><br>${proposal.terms}</div>` : ''}
${proposal.payment_terms ? `<p style="margin-top:12px;font-size:0.9rem;color:#64748b"><strong>Payment Terms:</strong> ${proposal.payment_terms}</p>` : ''}
<div class="comment-box"><h3>Questions or Comments</h3><textarea id="comment" placeholder="Leave a comment for ${proposal.tenant_name}..."></textarea>
<button onclick="postComment()">Send Comment</button><div id="comment-ok" style="display:none;color:#22c55e;margin-top:8px;font-size:0.9rem">Comment sent!</div></div>
</div>
${proposal.status !== 'accepted' && proposal.status !== 'declined' && proposal.status !== 'expired' ? `
<div class="footer-bar" id="action-bar">
<div><strong>$${proposal.total?.toLocaleString()} ${proposal.currency}</strong>${proposal.payment_terms ? `<br><small style="color:#64748b">${proposal.payment_terms}</small>` : ''}</div>
<div><button class="btn btn-decline" onclick="declineProposal()">Decline</button>
<button class="btn btn-accept" onclick="showSignature()">Accept Proposal</button></div></div>
<div id="sig-section" style="display:none" class="footer-bar"><div style="width:100%">
<h3 style="margin-bottom:12px">Sign to Accept</h3>
<div class="sig-area"><canvas id="sig-canvas" width="400" height="150"></canvas><br>
<button onclick="clearSig()" style="margin-top:8px;padding:4px 12px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;font-size:0.8rem">Clear</button></div>
<div style="margin-top:8px"><label style="font-size:0.85rem"><input type="text" id="signer-name" placeholder="Your full name" style="padding:8px;border:1px solid #e2e8f0;border-radius:6px;width:100%;margin-top:4px"></label></div>
<button class="btn btn-accept" style="margin-top:12px;width:100%" onclick="acceptProposal()">I Accept This Proposal</button></div></div>` : ''}
<div id="accepted-msg">${proposal.status === 'accepted' ? 'This proposal has been accepted.' : proposal.status === 'declined' ? 'This proposal was declined.' : proposal.status === 'expired' ? 'This proposal has expired.' : ''}</div>
${proposal.status === 'accepted' || proposal.status === 'declined' || proposal.status === 'expired' ? '<script>document.getElementById("accepted-msg").style.display="block";</script>' : ''}
</div>
<script>
var slug='${propSlug}';var ctx,drawing=false,canvas;
function showSignature(){document.getElementById('action-bar').style.display='none';document.getElementById('sig-section').style.display='flex';
canvas=document.getElementById('sig-canvas');ctx=canvas.getContext('2d');ctx.strokeStyle='#1e293b';ctx.lineWidth=2;
canvas.onmousedown=function(e){drawing=true;ctx.beginPath();ctx.moveTo(e.offsetX,e.offsetY)};
canvas.onmousemove=function(e){if(drawing){ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke()}};
canvas.onmouseup=function(){drawing=false};canvas.onmouseleave=function(){drawing=false};}
function clearSig(){if(ctx)ctx.clearRect(0,0,400,150)}
async function acceptProposal(){var name=document.getElementById('signer-name').value;if(!name){alert('Please enter your name');return}
var sig=canvas?canvas.toDataURL():'';var r=await fetch('/p/'+slug+'/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,signature:sig})});
if(r.ok){document.getElementById('sig-section').style.display='none';document.getElementById('accepted-msg').textContent='Proposal accepted! Thank you.';document.getElementById('accepted-msg').style.display='block'}
else{var d=await r.json();alert(d.error||'Error accepting proposal')}}
async function declineProposal(){var reason=prompt('Optional: Tell us why you are declining');
var r=await fetch('/p/'+slug+'/decline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:reason||''})});
if(r.ok){document.getElementById('action-bar').style.display='none';document.getElementById('accepted-msg').textContent='Proposal declined.';document.getElementById('accepted-msg').style.display='block'}
else{var d=await r.json();alert(d.error||'Error')}}
async function postComment(){var body=document.getElementById('comment').value;if(!body.trim())return;
var r=await fetch('/p/'+slug+'/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:body,author_name:'Client'})});
if(r.ok){document.getElementById('comment').value='';document.getElementById('comment-ok').style.display='block';setTimeout(function(){document.getElementById('comment-ok').style.display='none'},3000)}
else{alert('Error sending comment')}}
// Track view time
var startTime=Date.now();window.addEventListener('beforeunload',function(){var dur=Math.round((Date.now()-startTime)/1000);navigator.sendBeacon('/p/'+slug+'/time',JSON.stringify({duration:dur}))});
</script></body></html>`;
        return cors(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
      }

      // Public: accept proposal
      if (p.match(/^\/p\/[^/]+\/accept$/) && m === 'POST') {
        const propSlug = p.split('/')[2];
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (!await rateLimit(env.CACHE, `accept:${ip}`, 5, 3600)) return err('Rate limited', 429);
        const body = await req.json() as any;
        const proposal = await env.DB.prepare("SELECT * FROM proposals WHERE slug = ? AND status IN ('sent','viewed')").bind(propSlug).first();
        if (!proposal) return err('Proposal not found or already responded', 404);
        if (proposal.valid_until && new Date(proposal.valid_until as string) < new Date()) {
          await env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").bind(proposal.id).run();
          return err('Proposal has expired', 410);
        }
        await env.DB.prepare("UPDATE proposals SET status = 'accepted', accepted_at = datetime(?), accepted_by = ?, accepted_ip = ?, signature_data = ? WHERE id = ?")
          .bind('now', sanitize(body.name || 'Client', 100), ip, body.signature || null, proposal.id).run();
        await env.DB.prepare('INSERT INTO activity_log (tenant_id, proposal_id, action, details, actor) VALUES (?, ?, ?, ?, ?)').bind(proposal.tenant_id, proposal.id, 'accepted', JSON.stringify({ by: body.name, ip }), 'client').run();
        // Notify owner (fire-and-forget)
        (async () => {
          try {
            const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(proposal.tenant_id).first();
            if (tenant?.email) {
              await env.EMAIL_SENDER.fetch('https://email/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: tenant.email, subject: `Proposal "${proposal.title}" has been accepted!`, html: `<p>Great news! Your proposal <strong>"${proposal.title}"</strong> worth <strong>$${(proposal.total as number)?.toLocaleString()}</strong> has been accepted by <strong>${body.name || 'your client'}</strong>.</p>` })
              });
            }
          } catch {}
        })();
        return json({ accepted: true });
      }

      // Public: decline proposal
      if (p.match(/^\/p\/[^/]+\/decline$/) && m === 'POST') {
        const propSlug = p.split('/')[2];
        const body = await req.json() as any;
        const proposal = await env.DB.prepare("SELECT * FROM proposals WHERE slug = ? AND status IN ('sent','viewed')").bind(propSlug).first();
        if (!proposal) return err('Proposal not found or already responded', 404);
        await env.DB.prepare("UPDATE proposals SET status = 'declined', declined_at = datetime(?), decline_reason = ? WHERE id = ?").bind('now', body.reason || null, proposal.id).run();
        await env.DB.prepare('INSERT INTO activity_log (tenant_id, proposal_id, action, details, actor) VALUES (?, ?, ?, ?, ?)').bind(proposal.tenant_id, proposal.id, 'declined', JSON.stringify({ reason: body.reason }), 'client').run();
        return json({ declined: true });
      }

      // Public: client comment
      if (p.match(/^\/p\/[^/]+\/comment$/) && m === 'POST') {
        const propSlug = p.split('/')[2];
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (!await rateLimit(env.CACHE, `comment:${ip}`, 10, 3600)) return err('Rate limited', 429);
        const body = await req.json() as any;
        if (!body.body?.trim()) return err('Comment body required');
        const proposal = await env.DB.prepare('SELECT id, tenant_id FROM proposals WHERE slug = ?').bind(propSlug).first();
        if (!proposal) return err('Proposal not found', 404);
        const id = uid();
        await env.DB.prepare('INSERT INTO comments (id, proposal_id, tenant_id, author_name, author_type, body) VALUES (?, ?, ?, ?, ?, ?)').bind(id, proposal.id, proposal.tenant_id, sanitize(body.author_name || 'Client', 100), 'client', sanitize(body.body)).run();
        return json({ id }, 201);
      }

      // Public: track view time
      if (p.match(/^\/p\/[^/]+\/time$/) && m === 'POST') {
        const propSlug = p.split('/')[2];
        try {
          const body = await req.json() as any;
          const dur = Math.min(body.duration || 0, 3600);
          if (dur > 0) {
            await env.DB.prepare('UPDATE proposals SET total_view_time_sec = total_view_time_sec + ? WHERE slug = ?').bind(dur, propSlug).run();
          }
        } catch {}
        return json({ ok: true });
      }

      // ── Auth required ──
      if (!authOk(req, env)) return err('Unauthorized', 401);
      const tid = tenantId(req, url);

      // ── Tenants ──
      if (p === '/tenants' && m === 'POST') {
        const b = await req.json() as any;
        const id = uid();
        await env.DB.prepare('INSERT INTO tenants (id, name, logo_url, brand_color, website, email, phone, address, default_currency, default_tax_rate, payment_terms) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, sanitize(b.name, 200), b.logo_url || null, b.brand_color || '#14b8a6', b.website || null, b.email || null, b.phone || null, b.address || null, b.default_currency || 'USD', b.default_tax_rate || 0, b.payment_terms || 'Due on acceptance').run();
        return json({ id }, 201);
      }
      if (p === '/tenants' && m === 'GET') { const r = await env.DB.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all(); return json({ tenants: r.results }); }
      if (p.startsWith('/tenants/') && m === 'PUT') {
        const id = p.split('/')[2]; const b = await req.json() as any; const f: string[] = []; const v: any[] = [];
        for (const k of ['name','logo_url','brand_color','website','email','phone','address','default_currency','default_tax_rate','payment_terms']) { if (b[k] !== undefined) { f.push(`${k}=?`); v.push(typeof b[k]==='string'?sanitize(b[k],500):b[k]); } }
        if (f.length) { v.push(id); await env.DB.prepare(`UPDATE tenants SET ${f.join(',')} WHERE id=?`).bind(...v).run(); }
        return json({ updated: true });
      }

      // ── Clients ──
      if (p === '/clients' && m === 'POST') {
        const b = await req.json() as any; const id = uid();
        await env.DB.prepare('INSERT INTO clients (id,tenant_id,name,company,email,phone,address,notes) VALUES (?,?,?,?,?,?,?,?)')
          .bind(id, tid, sanitize(b.name,200), b.company||null, b.email||null, b.phone||null, b.address||null, b.notes||null).run();
        return json({ id }, 201);
      }
      if (p === '/clients' && m === 'GET') { const r = await env.DB.prepare('SELECT * FROM clients WHERE tenant_id=? ORDER BY name').bind(tid).all(); return json({ clients: r.results }); }
      if (p.match(/^\/clients\/[^/]+$/) && m === 'GET') { const id = p.split('/')[2]; const r = await env.DB.prepare('SELECT * FROM clients WHERE id=? AND tenant_id=?').bind(id,tid).first(); return r ? json(r) : err('Not found',404); }
      if (p.match(/^\/clients\/[^/]+$/) && m === 'PUT') {
        const id = p.split('/')[2]; const b = await req.json() as any; const f: string[] = []; const v: any[] = [];
        for (const k of ['name','company','email','phone','address','notes']) { if (b[k] !== undefined) { f.push(`${k}=?`); v.push(sanitize(String(b[k]),500)); } }
        if (f.length) { v.push(id,tid); await env.DB.prepare(`UPDATE clients SET ${f.join(',')} WHERE id=? AND tenant_id=?`).bind(...v).run(); }
        return json({ updated: true });
      }
      if (p.match(/^\/clients\/[^/]+$/) && m === 'DELETE') { const id = p.split('/')[2]; await env.DB.prepare('DELETE FROM clients WHERE id=? AND tenant_id=?').bind(id,tid).run(); return json({ deleted: true }); }

      // ── Templates ──
      if (p === '/templates' && m === 'POST') {
        const b = await req.json() as any; const id = uid();
        await env.DB.prepare('INSERT INTO templates (id,tenant_id,name,description,sections,pricing_table,terms,is_default) VALUES (?,?,?,?,?,?,?,?)')
          .bind(id, tid, sanitize(b.name,200), b.description||null, JSON.stringify(b.sections||[]), JSON.stringify(b.pricing_table||[]), b.terms||null, b.is_default?1:0).run();
        return json({ id }, 201);
      }
      if (p === '/templates' && m === 'GET') { const r = await env.DB.prepare('SELECT * FROM templates WHERE tenant_id=? ORDER BY use_count DESC').bind(tid).all(); return json({ templates: r.results }); }
      if (p.startsWith('/templates/') && m === 'PUT') {
        const id = p.split('/')[2]; const b = await req.json() as any; const f: string[] = []; const v: any[] = [];
        for (const k of ['name','description','terms','is_default']) { if (b[k] !== undefined) { f.push(`${k}=?`); v.push(typeof b[k]==='string'?sanitize(b[k],5000):b[k]); } }
        if (b.sections) { f.push('sections=?'); v.push(JSON.stringify(b.sections)); }
        if (b.pricing_table) { f.push('pricing_table=?'); v.push(JSON.stringify(b.pricing_table)); }
        if (f.length) { v.push(id,tid); await env.DB.prepare(`UPDATE templates SET ${f.join(',')} WHERE id=? AND tenant_id=?`).bind(...v).run(); }
        return json({ updated: true });
      }
      if (p.startsWith('/templates/') && m === 'DELETE') { const id = p.split('/')[2]; await env.DB.prepare('DELETE FROM templates WHERE id=? AND tenant_id=?').bind(id,tid).run(); return json({ deleted: true }); }

      // ── Content Blocks ──
      if (p === '/blocks' && m === 'POST') {
        const b = await req.json() as any; const id = uid();
        await env.DB.prepare('INSERT INTO content_blocks (id,tenant_id,name,type,content) VALUES (?,?,?,?,?)').bind(id, tid, sanitize(b.name,200), b.type||'text', JSON.stringify(b.content||{})).run();
        return json({ id }, 201);
      }
      if (p === '/blocks' && m === 'GET') { const r = await env.DB.prepare('SELECT * FROM content_blocks WHERE tenant_id=? ORDER BY use_count DESC').bind(tid).all(); return json({ blocks: r.results }); }
      if (p.startsWith('/blocks/') && m === 'DELETE') { const id = p.split('/')[2]; await env.DB.prepare('DELETE FROM content_blocks WHERE id=? AND tenant_id=?').bind(id,tid).run(); return json({ deleted: true }); }

      // ── Proposals ──
      if (p === '/proposals' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.title) return err('title required');
        const id = uid(); const propSlug = slug(); const number = `PROP-${Date.now().toString(36).toUpperCase()}`;
        const pricing = b.pricing_table || [];
        const { subtotal, total } = calcTotal(pricing, b.discount_type, b.discount_value, b.tax_rate);
        // If template specified, clone its sections/pricing
        let sections = b.sections || [];
        if (b.template_id && !b.sections?.length) {
          const tmpl = await env.DB.prepare('SELECT * FROM templates WHERE id=? AND tenant_id=?').bind(b.template_id, tid).first();
          if (tmpl) {
            sections = JSON.parse((tmpl.sections as string) || '[]');
            if (!pricing.length) { const tp = JSON.parse((tmpl.pricing_table as string) || '[]'); Object.assign(b, { pricing_table: tp }); }
            await env.DB.prepare('UPDATE templates SET use_count=use_count+1 WHERE id=?').bind(b.template_id).run();
          }
        }
        await env.DB.prepare(
          `INSERT INTO proposals (id,tenant_id,client_id,template_id,number,title,slug,sections,pricing_table,subtotal,discount_type,discount_value,tax_rate,total,currency,terms,payment_terms,valid_until,cover_image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, tid, b.client_id||null, b.template_id||null, number, sanitize(b.title,200), propSlug,
          JSON.stringify(sections), JSON.stringify(pricing), subtotal, b.discount_type||null, b.discount_value||0, b.tax_rate||0, total,
          b.currency||'USD', b.terms||null, b.payment_terms||null, b.valid_until||null, b.cover_image_url||null).run();
        if (b.client_id) await env.DB.prepare('UPDATE clients SET total_proposals=total_proposals+1, total_value=total_value+? WHERE id=?').bind(total, b.client_id).run();
        return json({ id, number, slug: propSlug, url: `${url.origin}/p/${propSlug}` }, 201);
      }

      if (p === '/proposals' && m === 'GET') {
        const status = url.searchParams.get('status');
        const clientId = url.searchParams.get('client_id');
        const limit = Math.min(parseInt(url.searchParams.get('limit')||'50'),200);
        let where = 'p.tenant_id=?'; const vals: any[] = [tid];
        if (status) { where += ' AND p.status=?'; vals.push(status); }
        if (clientId) { where += ' AND p.client_id=?'; vals.push(clientId); }
        vals.push(limit);
        const r = await env.DB.prepare(`SELECT p.*, c.name as client_name, c.company as client_company FROM proposals p LEFT JOIN clients c ON c.id=p.client_id WHERE ${where} ORDER BY p.created_at DESC LIMIT ?`).bind(...vals).all();
        return json({ proposals: r.results });
      }

      if (p.match(/^\/proposals\/[^/]+$/) && m === 'GET') {
        const id = p.split('/')[2];
        const r = await env.DB.prepare('SELECT p.*, c.name as client_name, c.company as client_company, c.email as client_email FROM proposals p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=? AND p.tenant_id=?').bind(id,tid).first();
        if (!r) return err('Not found',404);
        const comments = await env.DB.prepare('SELECT * FROM comments WHERE proposal_id=? ORDER BY created_at').bind(id).all();
        const views = await env.DB.prepare('SELECT * FROM proposal_views WHERE proposal_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all();
        return json({ ...r, comments: comments.results, views: views.results });
      }

      if (p.match(/^\/proposals\/[^/]+$/) && m === 'PUT') {
        const id = p.split('/')[2]; const b = await req.json() as any; const f: string[] = []; const v: any[] = [];
        for (const k of ['title','terms','payment_terms','valid_until','cover_image_url','custom_css','currency','discount_type','discount_value','tax_rate']) {
          if (b[k] !== undefined) { f.push(`${k}=?`); v.push(typeof b[k]==='string'?sanitize(b[k],5000):b[k]); }
        }
        if (b.sections) { f.push('sections=?'); v.push(JSON.stringify(b.sections)); }
        if (b.pricing_table) {
          f.push('pricing_table=?'); v.push(JSON.stringify(b.pricing_table));
          const { subtotal, total } = calcTotal(b.pricing_table, b.discount_type, b.discount_value, b.tax_rate);
          f.push('subtotal=?','total=?'); v.push(subtotal, total);
        }
        f.push("updated_at=datetime(?)"); v.push('now');
        if (f.length) { v.push(id,tid); await env.DB.prepare(`UPDATE proposals SET ${f.join(',')} WHERE id=? AND tenant_id=?`).bind(...v).run(); }
        return json({ updated: true });
      }

      if (p.match(/^\/proposals\/[^/]+$/) && m === 'DELETE') { const id = p.split('/')[2]; await env.DB.prepare('DELETE FROM proposals WHERE id=? AND tenant_id=?').bind(id,tid).run(); return json({ deleted: true }); }

      // Send proposal
      if (p.match(/^\/proposals\/[^/]+\/send$/) && m === 'POST') {
        const id = p.split('/')[2];
        const proposal = await env.DB.prepare("SELECT p.*, c.email as client_email, c.name as client_name FROM proposals p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=? AND p.tenant_id=?").bind(id,tid).first();
        if (!proposal) return err('Not found',404);
        if (!proposal.client_email) return err('Client has no email address');
        const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(tid).first();
        const viewUrl = `${url.origin}/p/${proposal.slug}`;
        await env.EMAIL_SENDER.fetch('https://email/send', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ to: proposal.client_email, subject: `Proposal: ${proposal.title}`,
            html: `<p>Hi ${proposal.client_name},</p><p>${(tenant as any)?.name || 'We'} have prepared a proposal for you.</p><p><a href="${viewUrl}" style="display:inline-block;padding:14px 32px;background:${(tenant as any)?.brand_color || '#14b8a6'};color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:1rem">View Proposal ($${(proposal.total as number)?.toLocaleString()})</a></p><p>This proposal${proposal.valid_until ? ` is valid until ${new Date(proposal.valid_until as string).toLocaleDateString()}` : ' has no expiration date'}.</p><p>Best regards,<br>${(tenant as any)?.name || 'The Team'}</p>` })
        });
        await env.DB.prepare("UPDATE proposals SET status='sent', sent_at=datetime(?) WHERE id=?").bind('now', id).run();
        await env.DB.prepare('INSERT INTO activity_log (tenant_id,proposal_id,action,details,actor) VALUES (?,?,?,?,?)').bind(tid, id, 'sent', JSON.stringify({ to: proposal.client_email }), 'owner').run();
        return json({ sent: true, url: viewUrl });
      }

      // Clone proposal
      if (p.match(/^\/proposals\/[^/]+\/clone$/) && m === 'POST') {
        const id = p.split('/')[2];
        const orig = await env.DB.prepare('SELECT * FROM proposals WHERE id=? AND tenant_id=?').bind(id,tid).first();
        if (!orig) return err('Not found',404);
        const newId = uid(); const newSlug = slug(); const number = `PROP-${Date.now().toString(36).toUpperCase()}`;
        await env.DB.prepare(
          `INSERT INTO proposals (id,tenant_id,client_id,template_id,number,title,slug,sections,pricing_table,subtotal,discount_type,discount_value,tax_rate,total,currency,terms,payment_terms,valid_until,cover_image_url,custom_css) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(newId, tid, orig.client_id, orig.template_id, number, `Copy of ${orig.title}`, newSlug,
          orig.sections, orig.pricing_table, orig.subtotal, orig.discount_type, orig.discount_value, orig.tax_rate, orig.total,
          orig.currency, orig.terms, orig.payment_terms, null, orig.cover_image_url, orig.custom_css).run();
        return json({ id: newId, number, slug: newSlug, url: `${url.origin}/p/${newSlug}` }, 201);
      }

      // Revise proposal (create new version)
      if (p.match(/^\/proposals\/[^/]+\/revise$/) && m === 'POST') {
        const id = p.split('/')[2];
        const orig = await env.DB.prepare('SELECT * FROM proposals WHERE id=? AND tenant_id=?').bind(id,tid).first();
        if (!orig) return err('Not found',404);
        const newId = uid(); const newSlug = slug(); const number = `${orig.number}-v${(orig.version as number || 1) + 1}`;
        await env.DB.prepare("UPDATE proposals SET status='revised' WHERE id=?").bind(id).run();
        const b = await req.json().catch(() => ({})) as any;
        const sections = b.sections || JSON.parse((orig.sections as string) || '[]');
        const pricing = b.pricing_table || JSON.parse((orig.pricing_table as string) || '[]');
        const { subtotal, total } = calcTotal(pricing, b.discount_type || orig.discount_type as string, b.discount_value ?? orig.discount_value as number, b.tax_rate ?? orig.tax_rate as number);
        await env.DB.prepare(
          `INSERT INTO proposals (id,tenant_id,client_id,template_id,number,title,slug,sections,pricing_table,subtotal,discount_type,discount_value,tax_rate,total,currency,terms,payment_terms,valid_until,cover_image_url,custom_css,version,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(newId, tid, orig.client_id, orig.template_id, number, b.title || orig.title, newSlug,
          JSON.stringify(sections), JSON.stringify(pricing), subtotal, b.discount_type||orig.discount_type, b.discount_value??orig.discount_value, b.tax_rate??orig.tax_rate, total,
          orig.currency, b.terms||orig.terms, b.payment_terms||orig.payment_terms, b.valid_until||null, orig.cover_image_url, orig.custom_css, (orig.version as number || 1) + 1, id).run();
        return json({ id: newId, number, slug: newSlug, version: (orig.version as number || 1) + 1 }, 201);
      }

      // Owner comment
      if (p.match(/^\/proposals\/[^/]+\/comments$/) && m === 'POST') {
        const propId = p.split('/')[2]; const b = await req.json() as any;
        if (!b.body?.trim()) return err('body required');
        const id = uid();
        await env.DB.prepare('INSERT INTO comments (id,proposal_id,tenant_id,author_name,author_type,body,section_ref) VALUES (?,?,?,?,?,?,?)')
          .bind(id, propId, tid, sanitize(b.author_name||'Owner',100), 'owner', sanitize(b.body), b.section_ref||null).run();
        return json({ id }, 201);
      }
      if (p.match(/^\/proposals\/[^/]+\/comments$/) && m === 'GET') {
        const propId = p.split('/')[2];
        const r = await env.DB.prepare('SELECT * FROM comments WHERE proposal_id=? AND tenant_id=? ORDER BY created_at').bind(propId,tid).all();
        return json({ comments: r.results });
      }

      // AI generate proposal content
      if (p === '/ai/generate' && m === 'POST') {
        const b = await req.json() as any;
        const prompt = `Generate a professional business proposal with the following details:
Client: ${b.client_name || 'the client'}
Project: ${b.project_description || b.title || 'a project'}
Industry: ${b.industry || 'general business'}

Create 4-5 sections:
1. Executive Summary (2-3 paragraphs)
2. Scope of Work (bullet points)
3. Timeline & Milestones
4. Why Choose Us
5. Next Steps

Use professional business language. Be specific and persuasive. Format each section with a title and content.
Return as JSON array: [{"title":"Section Name","type":"text","content":"<p>HTML content</p>"}]`;
        const sr = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 1500 }) });
        const sd = await sr.json() as any;
        const text = sd.response || sd.answer || '';
        // Try to parse JSON from response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        let sections = [];
        if (jsonMatch) { try { sections = JSON.parse(jsonMatch[0]); } catch { sections = [{ title: 'Proposal', type: 'text', content: `<p>${text}</p>` }]; } }
        else { sections = [{ title: 'Proposal', type: 'text', content: `<p>${text.replace(/\n/g, '</p><p>')}</p>` }]; }
        return json({ sections });
      }

      // AI suggest pricing
      if (p === '/ai/pricing' && m === 'POST') {
        const b = await req.json() as any;
        const prompt = `Suggest pricing line items for a business proposal:
Service: ${b.service_type || 'consulting'}
Description: ${b.description || 'professional services'}
Market: ${b.market || 'US SMB'}

Return 3-5 line items as JSON: [{"name":"Item Name","description":"Brief description","quantity":1,"unit_price":500}]
Make prices realistic for the market. Include setup fees if appropriate.`;
        const sr = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 500 }) });
        const sd = await sr.json() as any;
        const text = sd.response || sd.answer || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        let items = [];
        if (jsonMatch) { try { items = JSON.parse(jsonMatch[0]); } catch {} }
        return json({ pricing_table: items });
      }

      // ── Analytics ──
      if (p === '/analytics/overview' && m === 'GET') {
        const days = parseInt(url.searchParams.get('days')||'30');
        const since = new Date(Date.now()-days*86400000).toISOString().split('T')[0];
        const totals = await env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as accepted, SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) as declined, SUM(CASE WHEN status IN ('sent','viewed') THEN 1 ELSE 0 END) as pending, SUM(total) as total_value, SUM(CASE WHEN status='accepted' THEN total ELSE 0 END) as won_value, AVG(view_count) as avg_views, AVG(total_view_time_sec) as avg_view_time FROM proposals WHERE tenant_id=?`).bind(tid).first();
        const recent = await env.DB.prepare(`SELECT COUNT(*) as created, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as won FROM proposals WHERE tenant_id=? AND created_at>=?`).bind(tid, since).first();
        const pipeline = await env.DB.prepare(`SELECT status, COUNT(*) as count, SUM(total) as value FROM proposals WHERE tenant_id=? GROUP BY status`).bind(tid).all();
        const winRate = (totals as any)?.total > 0 ? ((totals as any)?.accepted / (totals as any)?.total * 100).toFixed(1) : '0';
        return json({ totals: { ...totals as any, win_rate: winRate }, recent, pipeline: pipeline.results });
      }

      if (p === '/analytics/trends' && m === 'GET') {
        const days = parseInt(url.searchParams.get('days')||'30');
        const since = new Date(Date.now()-days*86400000).toISOString().split('T')[0];
        const r = await env.DB.prepare('SELECT * FROM analytics_daily WHERE tenant_id=? AND date>=? ORDER BY date').bind(tid,since).all();
        return json({ trends: r.results });
      }

      // ── Export ──
      if (p === '/export' && m === 'GET') {
        const r = await env.DB.prepare('SELECT p.*, c.name as client_name, c.company as client_company FROM proposals p LEFT JOIN clients c ON c.id=p.client_id WHERE p.tenant_id=? ORDER BY p.created_at DESC').bind(tid).all();
        return json({ proposals: r.results, total: r.results?.length || 0 });
      }

      // ── Activity Log ──
      if (p === '/activity' && m === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit')||'50'),200);
        const r = await env.DB.prepare('SELECT * FROM activity_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?').bind(tid, limit).all();
        return json({ activity: r.results });
      }

      try { env.AE.writeDataPoint({ blobs: [req.method, p, '404'], doubles: [Date.now()], indexes: ['echo-proposals'] }); } catch {}
      return err('Not found', 404);
    } catch (e: any) {
      if (e.message?.includes('JSON')) {
        try { env.AE.writeDataPoint({ blobs: [req.method, new URL(req.url).pathname, '400'], doubles: [Date.now()], indexes: ['echo-proposals'] }); } catch {}
        return err('Invalid JSON body', 400);
      }
      slog('error', 'Unhandled request error', { error: e.message, stack: e.stack });
      try { env.AE.writeDataPoint({ blobs: [req.method, new URL(req.url).pathname, '500'], doubles: [Date.now()], indexes: ['echo-proposals'] }); } catch {}
      return err(e.message || 'Internal server error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const tenants = await env.DB.prepare('SELECT id FROM tenants').all();
    for (const t of (tenants.results || [])) {
      const tid = (t as any).id;
      const stats = await env.DB.prepare(
        `SELECT COUNT(*) as created, SUM(CASE WHEN status='sent' OR sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent,
         SUM(CASE WHEN first_viewed_at IS NOT NULL THEN 1 ELSE 0 END) as viewed,
         SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as accepted,
         SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) as declined,
         SUM(CASE WHEN sent_at IS NOT NULL THEN total ELSE 0 END) as value_sent,
         SUM(CASE WHEN status='accepted' THEN total ELSE 0 END) as value_won
         FROM proposals WHERE tenant_id=? AND DATE(created_at)=?`
      ).bind(tid, yesterday).first();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO analytics_daily (tenant_id,date,proposals_created,proposals_sent,proposals_viewed,proposals_accepted,proposals_declined,total_value_sent,total_value_won) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(tid, yesterday, (stats as any)?.created||0, (stats as any)?.sent||0, (stats as any)?.viewed||0, (stats as any)?.accepted||0, (stats as any)?.declined||0, (stats as any)?.value_sent||0, (stats as any)?.value_won||0).run();
    }
    // Expire proposals past valid_until
    await env.DB.prepare("UPDATE proposals SET status='expired' WHERE status IN ('sent','viewed') AND valid_until IS NOT NULL AND valid_until < datetime('now')").run();
  }
};
