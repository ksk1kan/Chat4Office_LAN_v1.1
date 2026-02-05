async function api(path, opts={}){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw j;
  return j;
}
const $ = (id)=>document.getElementById(id);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function fmtTime(ms){
  const d=new Date(ms); const pad=(n)=>String(n).padStart(2,'0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load(){
  const me = await api('/api/me').catch(()=>null);
  if(!me){ location.href='/login.html'; return; }
  if(me.role!=='admin'){ alert('Admin yetkisi gerekli.'); location.href='/index.html'; return; }

  const ures = await api('/api/users');
  renderUsers(ures.users||[]);

  const sres = await api('/api/settings');
  $('officeName').value = (sres.settings||{}).officeName || 'Chat4Office';
  $('soundUrl').value = (sres.settings||{}).soundUrl || '/notify.wav';

  await loadActivity();
}

function renderUsers(users){
  const list = $('userList'); list.innerHTML='';
  users.forEach(u=>{
    const div = document.createElement('div');
    div.className='item';
    div.innerHTML = `
      <div>
        <div style="font-weight:600">${escapeHtml(u.displayName)} <span class="badge" style="margin-left:6px">${escapeHtml(u.username)}</span></div>
        <div class="smallMuted">role: ${escapeHtml(u.role)}</div>
      </div>
      <div class="row">
        <button class="btn small" data-reset="${u.id}">Şifre Sıfırla</button>
        <button class="btn small danger" data-del="${u.id}">Sil</button>
      </div>`;
    list.appendChild(div);
  });

  list.querySelectorAll('[data-del]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-del');
      if(!confirm('Kullanıcı silinsin mi?')) return;
      try{ await api('/api/admin/users/'+id,{method:'DELETE'}); $('msg').textContent='Silindi.'; load(); }
      catch(e){ $('msg').textContent='Silinemedi: '+(e.error||''); }
    };
  });
  list.querySelectorAll('[data-reset]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-reset');
      const np = prompt('Yeni şifre:');
      if(!np) return;
      try{ await api('/api/admin/users/'+id+'/reset_password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:np})}); $('msg').textContent='Şifre güncellendi.'; loadActivity(); }
      catch(e){ $('msg').textContent='Hata: '+(e.error||''); }
    };
  });
}

$('btnAdd').onclick = async ()=>{
  $('msg').textContent='';
  const username = $('newUsername').value.trim();
  const displayName = $('newDisplay').value.trim();
  const password = $('newPassword').value;
  const role = $('newRole').value;
  if(!username || !password){ $('msg').textContent='Kullanıcı adı ve şifre zorunlu.'; return; }
  try{
    await api('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,displayName,password,role})});
    $('newUsername').value=''; $('newDisplay').value=''; $('newPassword').value='';
    $('msg').textContent='Eklendi.'; load();
  }catch(e){ $('msg').textContent='Hata: '+(e.error||''); }
};

$('btnSave').onclick = async ()=>{
  $('saveMsg').textContent='';
  try{
    await api('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({officeName:$('officeName').value, soundUrl:$('soundUrl').value})});
    $('saveMsg').textContent='Kaydedildi.';
    await loadActivity();
  }catch(e){ $('saveMsg').textContent='Hata: '+(e.error||''); }
};

$('btnLogout').onclick = async ()=>{
  try{ await api('/api/logout',{method:'POST'}); }catch(e){}
  location.href='/login.html';
};

async function loadActivity(){
  const res = await api('/api/admin/activity?limit=80');
  const list = $('activityList'); list.innerHTML='';
  (res.items||[]).forEach(it=>{
    const div=document.createElement('div'); div.className='note';
    div.innerHTML = `
      <div class="tag">${escapeHtml(fmtTime(it.at))}</div>
      <div style="margin-top:6px;font-weight:600">${escapeHtml(it.type)}</div>
      <div class="smallMuted" style="margin-top:6px;">${escapeHtml(JSON.stringify(it.payload||{}))}</div>
    `;
    list.appendChild(div);
  });
  if((res.items||[]).length===0){
    const div=document.createElement('div'); div.className='note'; div.innerHTML='<div class="smallMuted">Aktivite yok.</div>';
    list.appendChild(div);
  }
}

load();
