const state = {
  me:null, users:[], online:new Set(), selectedUserId:null,
  soundEnabled:false,
  settings:{officeName:"Chat4Office", soundUrl:"/sounds/notify.wav"},
  notes:[], notesTab:"open", editingNoteId:null,
  socket:null,
  unreadCounts:{},
  yt:{player:null}
};

const $ = (id)=>document.getElementById(id);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function fmtTime(ms){
  const d = new Date(ms); const pad=(n)=>String(n).padStart(2,'0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
async function api(path, opts={}){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw j;
  return j;
}

async function init(){
  state.soundEnabled = localStorage.getItem('c4o_sound')==='1';
  updateSoundButton();

  state.me = await api('/api/me').catch(()=>null);
  if(!state.me){ location.href='/login.html'; return; }
  $('meBadge').textContent = `${state.me.displayName} (${state.me.username})`;

  state.settings = (await api('/api/settings')).settings || state.settings;
  $('officeName').textContent = state.settings.officeName || 'Chat4Office';
  if(state.me.role==='admin') $('adminLink').style.display='inline-flex';

  state.users = (await api('/api/users')).users || [];
  fillAssignees();

  await refreshUnreadCounts();
  renderUsers();
  await loadNotes(false);

  state.socket = io();
  state.socket.on('presence', ({online})=>{
    state.online = new Set(online||[]);
    renderUsers();
    updateChatStatus();
  });
  state.socket.on('dm_new', async (msg)=>{
    if(msg.toId===state.me.id && (!state.selectedUserId || state.selectedUserId!==msg.fromId)){
      await refreshUnreadCounts();
      renderUsers();
    }
    if(state.selectedUserId && (
      (msg.fromId===state.selectedUserId && msg.toId===state.me.id) ||
      (msg.toId===state.selectedUserId && msg.fromId===state.me.id)
    )){
      appendMessage(msg);
      scrollChatBottom();
      if(msg.toId===state.me.id){
        state.socket.emit('dm_mark_read',{otherId: state.selectedUserId});
        await refreshUnreadCounts();
        renderUsers();
        updateAllMessageReadBadges();
      }
    }
  });
  state.socket.on('dm_read', ({readerId})=>{
    if(state.selectedUserId && state.selectedUserId===readerId){
      updateAllMessageReadBadges();
    }
  });
  state.socket.on('dm_counts_changed', async ()=>{
    await refreshUnreadCounts();
    renderUsers();
  });

  state.socket.on('reminder_due', async ({noteId})=>{
    await loadNotes(true);
    const note = state.notes.find(n=>n.id===noteId);
    if(note) showReminder(note);
  });

  $('btnLogout').onclick = logout;
  $('btnSend').onclick = sendDm;
  $('chatInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter') sendDm(); });

  document.querySelectorAll('.tab').forEach(t=>{
    t.onclick = async ()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      state.notesTab = t.getAttribute('data-tab');
      await loadNotes(false);
    };
  });

  $('btnNewNote').onclick = ()=> openNoteModal(null);
  $('modalClose').onclick = closeNoteModal;
  $('modalBack').addEventListener('click', (e)=>{ if(e.target.id==='modalBack') closeNoteModal(); });
  $('btnSaveNote').onclick = saveNote;
  $('btnDeleteNote').onclick = deleteNote;

  $('btnSound').onclick = async ()=>{
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('c4o_sound', state.soundEnabled ? '1' : '0');
    updateSoundButton();
    if(state.soundEnabled) await warmupSound();
  };

  $('remClose').onclick = closeReminder;
  $('remBack').addEventListener('click', (e)=>{ if(e.target.id==='remBack') closeReminder(); });
  document.querySelectorAll('#remBack [data-snooze]').forEach(b=>{
    b.onclick = ()=> snoozeCurrentReminder(Number(b.getAttribute('data-snooze')));
  });
  $('btnDone').onclick = doneCurrentReminder;

  setInterval(async ()=>{
    await refreshUnreadCounts();
    renderUsers();
  }, 6000);
}

async function refreshUnreadCounts(){
  const res = await api('/api/unread_counts').catch(()=>({counts:{}}));
  state.unreadCounts = res.counts || {};
}

async function logout(){ try{ await api('/api/logout',{method:'POST'}); }catch(e){} location.href='/login.html'; }
function updateSoundButton(){ $('btnSound').textContent = state.soundEnabled ? '🔊 Ses açık' : '🔇 Sesli uyarıyı etkinleştir'; }

function renderUsers(){
  const list = $('usersList'); list.innerHTML='';
  $('onlineCount').textContent = `${state.online.size} online`;
  state.users
    .filter(u=>u.id!==state.me.id)
    .sort((a,b)=>a.displayName.localeCompare(b.displayName))
    .forEach(u=>{
      const isOn = state.online.has(u.id);
      const active = state.selectedUserId===u.id;
      const unread = state.unreadCounts[u.id] || 0;
      const div = document.createElement('div');
      div.className = 'item'+(active?' active':'');
      div.innerHTML = `
        <div>
          <div style="font-weight:600"><span class="dot ${isOn?'on':''}"></span>${escapeHtml(u.displayName)}</div>
          <div class="pill">@${escapeHtml(u.username)}</div>
        </div>
        <div class="row">
          ${unread?`<span class="badgeCount new">${unread} yeni</span>`:''}
          <span class="pill">${isOn?'online':'offline'}</span>
        </div>`;
      div.onclick = ()=> selectUser(u.id);
      list.appendChild(div);
    });
}

async function selectUser(userId){
  state.selectedUserId = userId;
  renderUsers();
  updateChatStatus();

  const u = state.users.find(x=>x.id===userId);
  $('chatTitle').textContent = u ? u.displayName : 'DM';
  $('chatSub').textContent = u ? `@${u.username}` : '';

  $('chatInput').disabled=false; $('btnSend').disabled=false;
  $('chatLog').innerHTML='';
  const {messages} = await api('/api/messages/'+userId);
  (messages||[]).forEach(appendMessage);
  scrollChatBottom();

  state.socket.emit('dm_mark_read',{otherId:userId});
  await refreshUnreadCounts();
  renderUsers();
  updateAllMessageReadBadges();
}

function updateChatStatus(){
  const st = $('chatStatus');
  if(!state.selectedUserId){ st.textContent='-'; return; }
  st.textContent = state.online.has(state.selectedUserId) ? 'online' : 'offline';
}

function appendMessage(msg){
  const div = document.createElement('div');
  div.className = 'bubble '+(msg.fromId===state.me.id?'me':'');
  const sender = msg.fromId===state.me.id ? 'Sen' : (state.users.find(u=>u.id===msg.fromId)?.displayName || 'Diğer');
  const readInfo = (msg.fromId===state.me.id)
    ? (msg.readAt ? `✓✓ Görüldü ${fmtTime(msg.readAt)}` : '✓ Gönderildi')
    : '';
  div.dataset.mid = msg.id;
  div.innerHTML = `
    <div>${escapeHtml(msg.text)}</div>
    <div class="meta">
      <span>${escapeHtml(sender)} • ${fmtTime(msg.createdAt)}</span>
      <span class="pill" data-read>${escapeHtml(readInfo)}</span>
    </div>`;
  $('chatLog').appendChild(div);
}

function updateAllMessageReadBadges(){
  if(!state.selectedUserId) return;
  api('/api/messages/'+state.selectedUserId).then(({messages})=>{
    const byId = new Map((messages||[]).map(m=>[m.id,m]));
    document.querySelectorAll('#chatLog .bubble.me').forEach(b=>{
      const mid=b.dataset.mid;
      const m=byId.get(mid);
      const el=b.querySelector('[data-read]');
      if(el && m){
        el.textContent = m.readAt ? `✓✓ Görüldü ${fmtTime(m.readAt)}` : '✓ Gönderildi';
      }
    });
  }).catch(()=>{});
}

function scrollChatBottom(){ const el=$('chatLog'); el.scrollTop = el.scrollHeight; }
function sendDm(){
  const text = $('chatInput').value.trim();
  if(!text || !state.selectedUserId) return;
  state.socket.emit('dm_send',{toId:state.selectedUserId, text});
  $('chatInput').value='';
}

// Notes
async function loadNotes(){
  const scope = (state.notesTab==='created') ? 'created' : 'inbox';
  const {notes} = await api('/api/notes?scope='+encodeURIComponent(scope));
  state.notes = notes || [];
  renderNotes();

  const ids = getVisibleNoteIdsForMarkSeen();
  if(ids.length){
    api('/api/notes/mark_seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noteIds:ids})}).catch(()=>{});
  }
}
function getVisibleNoteIdsForMarkSeen(){
  const tab = state.notesTab;
  let items = state.notes.slice();
  if(tab==='done') items = items.filter(n=>n.status==='done');
  else if(tab==='created') items = items.filter(n=>n.creatorId===state.me.id);
  else items = items.filter(n=>n.status==='open');
  return items.map(n=>n.id);
}

function renderNotes(){
  const list = $('notesList'); list.innerHTML='';
  const tab = state.notesTab;

  let items = state.notes.slice();
  if(tab==='done') items = items.filter(n=>n.status==='done');
  else if(tab==='created') items = items.filter(n=>n.creatorId===state.me.id);
  else items = items.filter(n=>n.status==='open');

  if(items.length===0){
    const empty=document.createElement('div'); empty.className='note';
    empty.innerHTML=`<div class="smallMuted">Kayıt yok.</div>`; list.appendChild(empty); return;
  }

  items.sort((a,b)=>(a.dueAt||9e15)-(b.dueAt||9e15)).forEach(n=>{
    const div=document.createElement('div'); div.className='note';
    const creatorName = (n.creatorId===state.me.id) ? state.me.displayName : (state.users.find(u=>u.id===n.creatorId)?.displayName || 'Bilinmiyor');
    const assigneesNames = (n.assignees||[]).map(id=> id===state.me.id ? state.me.displayName : (state.users.find(u=>u.id===id)?.displayName || '???')).join(', ');
    const due = n.dueAt ? `⏰ ${fmtTime(n.dueAt)}` : `📝 Not`;
    const imp = n.important ? `<span class="star">⭐</span>` : '';
    const doneInfo = n.status==='done' ? `✅ ${fmtTime(n.doneAt||n.updatedAt)}` : '';
    const doneBy = n.status==='done' ? (n.doneById===state.me.id ? state.me.displayName : (state.users.find(u=>u.id===n.doneById)?.displayName || 'Bilinmiyor')) : '';

    const mySeenAt = (n.seenBy||{})[state.me.id] || 0;
    const isNewForMe = (n.updatedAt || n.createdAt) > mySeenAt;
    const newBadge = isNewForMe ? `<span class="badgeCount new">Yeni</span>` : '';

    let seenSummary = '';
    if(n.creatorId===state.me.id){
      const seenBy = n.seenBy || {};
      const total = (n.assignees||[]).length;
      const seenCount = (n.assignees||[]).filter(id=>!!seenBy[id]).length;
      seenSummary = `<span class="tag">Okundu: ${seenCount}/${total}</span>`;
    }

    const canDelete = (state.me.role==='admin' || n.creatorId===state.me.id);

    div.innerHTML = `
      <div class="noteTop">
        <div class="row">${imp}${newBadge}<span class="tag">${escapeHtml(due)}</span>${n.snoozeUntil?`<span class="tag">😴 Erteli: ${fmtTime(n.snoozeUntil)}</span>`:''}${doneInfo?`<span class="tag">${escapeHtml(doneInfo)}</span>`:''}${doneBy?`<span class="tag">Bitiren: ${escapeHtml(doneBy)}</span>`:''}${seenSummary}</div>
        <div class="row">
          ${n.status==='open'?`<button class="btn small" data-done="${n.id}">Bitir</button>`:''}
          <button class="btn small" data-edit="${n.id}">Düzenle</button>
          ${canDelete?`<button class="btn small danger" data-del="${n.id}">Sil</button>`:''}
        </div>
      </div>
      <div class="noteText" style="margin-top:8px;">${escapeHtml(n.text)}</div>
      <div class="tag" style="margin-top:8px;">Yazan: ${escapeHtml(creatorName)} • Kime: ${escapeHtml(assigneesNames)}</div>`;
    list.appendChild(div);
  });

  list.querySelectorAll('[data-done]').forEach(b=> b.onclick = async ()=>{
    await api('/api/notes/'+b.getAttribute('data-done')+'/done',{method:'POST'});
    await loadNotes();
  });
  list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{
    const id=b.getAttribute('data-edit');
    openNoteModal(state.notes.find(x=>x.id===id));
  });
  list.querySelectorAll('[data-del]').forEach(b=> b.onclick = async ()=>{
    const id=b.getAttribute('data-del');
    if(!confirm('Silinsin mi?')) return;
    await api('/api/notes/'+id,{method:'DELETE'}).catch(()=>{ alert('Silme yetkin yok.'); });
    await loadNotes();
  });
}

function fillAssignees(){
  const sel = $('noteAssignees'); sel.innerHTML='';
  const all = [state.me, ...state.users.filter(u=>u.id!==state.me.id)].sort((a,b)=>a.displayName.localeCompare(b.displayName));
  all.forEach(u=>{
    const opt=document.createElement('option');
    opt.value=u.id; opt.textContent=`${u.displayName} (@${u.username})`;
    sel.appendChild(opt);
  });
}

function openNoteModal(note){
  state.editingNoteId = note ? note.id : null;
  $('modalTitle').textContent = note ? 'Düzenle' : 'Yeni Not / Hatırlatma';
  $('noteText').value = note ? note.text : '';
  $('noteImportant').checked = note ? !!note.important : false;

  if(note && note.dueAt){
    const d=new Date(note.dueAt); const pad=(n)=>String(n).padStart(2,'0');
    $('noteDue').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else $('noteDue').value = '';

  const ids = note ? (note.assignees||[]) : [state.me.id];
  Array.from($('noteAssignees').options).forEach(o=>o.selected = ids.includes(o.value));

  const canDelete = note && (state.me.role==='admin' || note.creatorId===state.me.id);
  $('btnDeleteNote').style.display = canDelete ? 'inline-flex' : 'none';

  $('modalBack').style.display='flex';
}
function closeNoteModal(){ $('modalBack').style.display='none'; state.editingNoteId=null; }

async function saveNote(){
  const text=$('noteText').value.trim();
  const important=$('noteImportant').checked;
  const dueVal=$('noteDue').value;
  const dueAt = dueVal ? new Date(dueVal).getTime() : null;
  const assignees = Array.from($('noteAssignees').selectedOptions).map(o=>o.value);
  if(!text){ alert('Metin boş olamaz.'); return; }
  if(assignees.length===0){ alert('En az 1 kişi seç.'); return; }
  if(state.editingNoteId){
    await api('/api/notes/'+state.editingNoteId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,important,dueAt,assignees})});
  }else{
    await api('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,important,dueAt,assignees})});
  }
  closeNoteModal(); await loadNotes();
}
async function deleteNote(){
  if(!state.editingNoteId) return;
  if(!confirm('Silinsin mi?')) return;
  await api('/api/notes/'+state.editingNoteId,{method:'DELETE'}).catch(()=>{ alert('Silme yetkin yok.'); });
  closeNoteModal(); await loadNotes();
}

// Reminder modal
let currentReminder=null;
async function showReminder(note){
  currentReminder=note;
  $('remText').textContent = note.text;
  const creator = (note.creatorId===state.me.id) ? state.me.displayName : (state.users.find(u=>u.id===note.creatorId)?.displayName || 'Bilinmiyor');
  $('remMeta').textContent = `Yazan: ${creator} • Tarih: ${note.dueAt ? fmtTime(note.dueAt) : '-'}`;
  $('remBack').style.display='flex';
  if(state.soundEnabled) await playSound();
}
function closeReminder(){ $('remBack').style.display='none'; currentReminder=null; stopYouTube(); }
async function doneCurrentReminder(){
  if(!currentReminder) return;
  await api('/api/notes/'+currentReminder.id+'/done',{method:'POST'});
  closeReminder(); await loadNotes();
}
async function snoozeCurrentReminder(mins){
  if(!currentReminder) return;
  await api('/api/notes/'+currentReminder.id+'/snooze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:mins})});
  closeReminder(); await loadNotes();
}

// Sound
function isYouTubeUrl(url){ return /youtube\.com|youtu\.be/.test(String(url||'')); }
function extractYouTubeId(url){
  url=String(url||'');
  let m=url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  m=url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  m=url.match(/shorts\/([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  return null;
}
function stopYouTube(){ try{ if(state.yt.player) state.yt.player.stopVideo(); }catch(e){} }

async function warmupSound(){
  try{
    const url = state.settings.soundUrl || '/sounds/notify.wav';
    if(isYouTubeUrl(url)){
      await ensureYouTubeReady(url);
      try{ state.yt.player.playVideo(); setTimeout(()=>{ try{ state.yt.player.stopVideo(); }catch(e){} }, 200); }catch(e){}
    }else{
      const a=new Audio(url); a.volume=1.0;
      await a.play().catch(()=>{}); a.pause();
    }
  }catch(e){}
}
async function playSound(){
  const url = state.settings.soundUrl || '/sounds/notify.wav';
  if(isYouTubeUrl(url)){ await ensureYouTubeReady(url); try{ state.yt.player.playVideo(); }catch(e){}; return; }
  try{ const a=new Audio(url); a.volume=1.0; await a.play(); }catch(e){}
}
async function ensureYouTubeReady(url){
  const vid = extractYouTubeId(url) || 'dQw4w9WgXcQ';
  if(state.yt.player){ try{ state.yt.player.loadVideoById(vid); }catch(e){}; return; }
  await loadYouTubeApi();
  if(!document.getElementById('ytPlayer')){
    const div=document.createElement('div'); div.id='ytPlayer';
    div.style.position='fixed'; div.style.left='-9999px'; div.style.top='-9999px';
    document.body.appendChild(div);
  }
  return new Promise((resolve)=>{
    window.onYouTubeIframeAPIReady = ()=>{
      state.yt.player = new YT.Player('ytPlayer',{height:'0',width:'0',videoId:vid,playerVars:{autoplay:0,controls:0,rel:0},events:{onReady:()=>resolve()}});
    };
    if(window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();
  });
}
function loadYouTubeApi(){
  return new Promise((resolve)=>{
    if(document.getElementById('ytApi')){ resolve(); return; }
    const s=document.createElement('script'); s.id='ytApi'; s.src='https://www.youtube.com/iframe_api'; s.onload=()=>resolve();
    document.head.appendChild(s);
  });
}

init();
