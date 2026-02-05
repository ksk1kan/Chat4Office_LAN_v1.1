const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "db.json");

function nowMs(){ return Date.now(); }
function uid(prefix="id"){ return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }

function normalizeDb(db){
  db.users = Array.isArray(db.users) ? db.users : [];
  db.messages = Array.isArray(db.messages) ? db.messages : [];
  db.notes = Array.isArray(db.notes) ? db.notes : [];
  db.activity = Array.isArray(db.activity) ? db.activity : [];
  db.settings = db.settings || { officeName:"Chat4Office", soundUrl:"/sounds/notify.wav" };

  for(const m of db.messages){
    if(m.readAt === undefined) m.readAt = null;
  }
  for(const n of db.notes){
    if(!n.seenBy || typeof n.seenBy !== "object") n.seenBy = {};
  }
  return db;
}

function readDb(){
  const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  return normalizeDb(raw);
}

let writeQueue = Promise.resolve();
function writeDbAtomic(db){
  db = normalizeDb(db);
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    try{
      const tmp = DB_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(tmp, DB_PATH);
      resolve();
    }catch(e){ reject(e); }
  }));
  return writeQueue;
}

function scryptHash(password, saltHex){
  const salt = Buffer.from(saltHex, "hex");
  const key = crypto.scryptSync(String(password), salt, 32, { N: 2**14, r: 8, p: 1 });
  return key.toString("hex");
}

function addLog(db, type, actorId, payload){
  db.activity = Array.isArray(db.activity) ? db.activity : [];
  db.activity.push({ id: uid("a"), type, actorId, payload: payload || {}, at: nowMs() });
  if(db.activity.length > 2000) db.activity.splice(0, db.activity.length - 2000);
}

function requireAuth(req,res,next){
  if(!req.session || !req.session.userId) return res.status(401).json({error:"auth_required"});
  next();
}
function requireAdmin(req,res,next){
  const db = readDb();
  const u = db.users.find(x=>x.id===req.session.userId);
  if(!u || u.role!=="admin") return res.status(403).json({error:"admin_required"});
  next();
}

const app = express();
app.use(express.json({limit:"1mb"}));

const sessionMw = session({
  secret: process.env.SESSION_SECRET || "chat4office_change_me",
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax"}
});
app.use(sessionMw);
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/me", requireAuth, (req,res)=>{
  const db = readDb();
  const u = db.users.find(x=>x.id===req.session.userId);
  if(!u) return res.status(401).json({error:"auth_required"});
  res.json({id:u.id,username:u.username,displayName:u.displayName,role:u.role});
});
app.get("/api/users", requireAuth, (req,res)=>{
  const db = readDb();
  res.json({users: db.users.map(u=>({id:u.id,username:u.username,displayName:u.displayName,role:u.role}))});
});
app.get("/api/settings", requireAuth, (req,res)=>{
  const db = readDb();
  res.json({settings: db.settings || {}});
});

app.post("/api/login",(req,res)=>{
  const {username,password} = req.body || {};
  if(!username || !password) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  const u = db.users.find(x=>x.username.toLowerCase()===String(username).toLowerCase());
  if(!u) return res.status(401).json({error:"invalid_credentials"});
  const candidate = scryptHash(password, u.pwSalt);
  if(candidate !== u.pwHash) return res.status(401).json({error:"invalid_credentials"});
  req.session.userId = u.id;
  res.json({ok:true});
});
app.post("/api/logout", requireAuth, (req,res)=> req.session.destroy(()=>res.json({ok:true})));

// Admin users
app.post("/api/admin/users", requireAuth, requireAdmin, async (req,res)=>{
  const {username,displayName,password,role} = req.body || {};
  if(!username || !password) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  if(db.users.some(u=>u.username.toLowerCase()===String(username).toLowerCase())) return res.status(409).json({error:"username_taken"});
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(password, salt);
  const user = {id:uid("u"),username:String(username),displayName:displayName?String(displayName):String(username),role:(role==="admin"?"admin":"user"),pwSalt:salt,pwHash:hash,createdAt:nowMs()};
  db.users.push(user);
  addLog(db, "user_created", req.session.userId, { userId:user.id, username:user.username, role:user.role });
  await writeDbAtomic(db);
  res.json({ok:true,user:{id:user.id,username:user.username,displayName:user.displayName,role:user.role}});
});
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req,res)=>{
  const id = req.params.id;
  if(id==="u_admin") return res.status(400).json({error:"cannot_delete_default_admin"});
  const db = readDb();
  db.users = db.users.filter(u=>u.id!==id);
  db.messages = db.messages.filter(m=>m.fromId!==id && m.toId!==id);
  db.notes = db.notes.filter(n=>n.creatorId!==id && !(n.assignees||[]).includes(id));
  addLog(db, "user_deleted", req.session.userId, { userId:id });
  await writeDbAtomic(db);
  res.json({ok:true});
});
app.post("/api/admin/users/:id/reset_password", requireAuth, requireAdmin, async (req,res)=>{
  const {newPassword} = req.body || {};
  if(!newPassword) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  const u = db.users.find(x=>x.id===req.params.id);
  if(!u) return res.status(404).json({error:"not_found"});
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(newPassword, salt);
  u.pwSalt = salt; u.pwHash = hash;
  addLog(db, "password_reset", req.session.userId, { userId:u.id });
  await writeDbAtomic(db);
  res.json({ok:true});
});

// Admin settings
app.post("/api/admin/settings", requireAuth, requireAdmin, async (req,res)=>{
  const {officeName,soundUrl} = req.body || {};
  const db = readDb();
  db.settings = db.settings || {};
  if(officeName !== undefined) db.settings.officeName = String(officeName);
  if(soundUrl !== undefined) db.settings.soundUrl = String(soundUrl);
  addLog(db, "settings_updated", req.session.userId, { officeName:db.settings.officeName, soundUrl:db.settings.soundUrl });
  await writeDbAtomic(db);
  res.json({ok:true,settings:db.settings});
});

// Admin activity
app.get("/api/admin/activity", requireAuth, requireAdmin, (req,res)=>{
  const db = readDb();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit)||200));
  const items = (db.activity||[]).slice(-limit).reverse();
  res.json({items});
});

// Unread counts (DM)
app.get("/api/unread_counts", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const counts = {};
  for(const m of db.messages){
    if(m.toId===me && !m.readAt){
      counts[m.fromId] = (counts[m.fromId]||0) + 1;
    }
  }
  res.json({counts});
});

// DM history
app.get("/api/messages/:otherUserId", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const other = req.params.otherUserId;
  const msgs = db.messages
    .filter(m => (m.fromId===me && m.toId===other) || (m.fromId===other && m.toId===me))
    .sort((a,b)=>a.createdAt-b.createdAt)
    .slice(-500);
  res.json({messages:msgs});
});

// Notes
app.get("/api/notes", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const scope = String(req.query.scope||"inbox"); // inbox | created | all
  let notes = db.notes || [];
  if(scope==="created"){
    notes = notes.filter(n=>n.creatorId===me);
  }else if(scope==="all"){
    const u = db.users.find(x=>x.id===me);
    if(!(u && u.role==="admin")) notes = notes.filter(n=>(n.assignees||[]).includes(me) || n.creatorId===me);
  }else{
    notes = notes.filter(n=>(n.assignees||[]).includes(me) || n.creatorId===me);
  }
  notes = notes.sort((a,b)=>(a.dueAt||9e15)-(b.dueAt||9e15));
  res.json({notes});
});

app.post("/api/notes/mark_seen", requireAuth, async (req,res)=>{
  const noteIds = Array.isArray((req.body||{}).noteIds) ? (req.body||{}).noteIds.map(String) : [];
  const db = readDb();
  const me = req.session.userId;
  const now = nowMs();
  let changed = false;
  for(const id of noteIds){
    const n = db.notes.find(x=>x.id===id);
    if(!n) continue;
    const allowed = (n.creatorId===me) || (n.assignees||[]).includes(me);
    if(!allowed) continue;
    n.seenBy = n.seenBy && typeof n.seenBy==="object" ? n.seenBy : {};
    n.seenBy[me] = now;
    changed = true;
  }
  if(changed) await writeDbAtomic(db);
  res.json({ok:true});
});

app.post("/api/notes", requireAuth, async (req,res)=>{
  const {text,assignees,dueAt,important} = req.body || {};
  if(!text || !String(text).trim()) return res.status(400).json({error:"empty"});
  const db = readDb();
  const me = req.session.userId;
  const ass = Array.isArray(assignees) ? assignees.map(String) : [];
  const finalAssignees = (ass.length?ass:[me]).filter((v,i,a)=>a.indexOf(v)===i);
  const n = {id:uid("n"),creatorId:me,assignees:finalAssignees,text:String(text).trim(),important:!!important,dueAt:dueAt?Number(dueAt):null,status:"open",snoozeUntil:null,lastTriggeredAt:null,seenBy:{},createdAt:nowMs(),updatedAt:nowMs(),doneById:null,doneAt:null};
  n.seenBy[me] = n.createdAt;
  db.notes.push(n);
  addLog(db, "note_created", me, { noteId:n.id, dueAt:n.dueAt, important:n.important, assignees:n.assignees });
  await writeDbAtomic(db);
  res.json({ok:true,note:n});
});

app.patch("/api/notes/:id", requireAuth, async (req,res)=>{
  const {text,assignees,dueAt,important} = req.body || {};
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  if(!(note.creatorId===me || isAdmin)) return res.status(403).json({error:"forbidden"});

  if(text !== undefined) note.text = String(text).trim();
  if(important !== undefined) note.important = !!important;
  if(dueAt !== undefined) note.dueAt = dueAt ? Number(dueAt) : null;
  if(assignees !== undefined){
    const ass = Array.isArray(assignees) ? assignees.map(String) : [];
    note.assignees = (ass.length?ass:[note.creatorId]).filter((v,i,a)=>a.indexOf(v)===i);
  }
  note.updatedAt = nowMs();
  note.lastTriggeredAt = null;

  addLog(db, "note_updated", me, { noteId:note.id, dueAt:note.dueAt, important:note.important, assignees:note.assignees });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.post("/api/notes/:id/done", requireAuth, async (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me || (note.assignees||[]).includes(me);
  if(!allowed) return res.status(403).json({error:"forbidden"});
  note.status="done";
  note.doneById=me;
  note.doneAt=nowMs();
  note.updatedAt=nowMs();
  addLog(db, "note_done", me, { noteId:note.id });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.post("/api/notes/:id/snooze", requireAuth, async (req,res)=>{
  const mins = Number((req.body||{}).minutes);
  if(!mins || mins<1 || mins>1440) return res.status(400).json({error:"invalid_minutes"});
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me || (note.assignees||[]).includes(me);
  if(!allowed) return res.status(403).json({error:"forbidden"});
  note.snoozeUntil = nowMs() + mins*60*1000;
  note.lastTriggeredAt = null;
  note.updatedAt = nowMs();
  addLog(db, "note_snoozed", me, { noteId:note.id, minutes:mins });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.delete("/api/notes/:id", requireAuth, async (req,res)=>{
  // Silme: sadece oluşturan kişi + admin
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me;
  if(!allowed) return res.status(403).json({error:"forbidden"});
  db.notes = db.notes.filter(x=>x.id!==req.params.id);
  addLog(db, "note_deleted", me, { noteId:note.id });
  await writeDbAtomic(db);
  res.json({ok:true});
});

// Socket.IO
const server = http.createServer(app);
const io = new Server(server);

const onlineByUserId = new Map(); // userId -> Set(socketId)

io.use((socket,next)=>sessionMw(socket.request, socket.request.res||{}, next));

function emitPresence(){
  io.emit("presence",{online:Array.from(onlineByUserId.keys())});
}
function emitToUser(userId, event, payload){
  const set = onlineByUserId.get(userId);
  if(set) for(const sid of set) io.to(sid).emit(event, payload);
}

io.on("connection",(socket)=>{
  const userId = socket.request.session && socket.request.session.userId;
  if(!userId){ socket.disconnect(true); return; }

  if(!onlineByUserId.has(userId)) onlineByUserId.set(userId, new Set());
  onlineByUserId.get(userId).add(socket.id);
  emitPresence();

  socket.on("dm_send", async ({toId,text})=>{
    if(!toId || !text || !String(text).trim()) return;
    const db = readDb();
    const msg = {id:uid("m"),fromId:userId,toId:String(toId),text:String(text).trim(),createdAt:nowMs(),readAt:null};
    db.messages.push(msg);
    addLog(db, "dm_sent", userId, { toId:String(toId), messageId:msg.id });
    await writeDbAtomic(db);
    emitToUser(userId, "dm_new", msg);
    emitToUser(String(toId), "dm_new", msg);
  });

  socket.on("dm_mark_read", async ({otherId})=>{
    if(!otherId) return;
    const db = readDb();
    const now = nowMs();
    let changed = false;
    for(const m of db.messages){
      if(m.fromId===String(otherId) && m.toId===userId && !m.readAt){
        m.readAt = now;
        changed = true;
      }
    }
    if(changed){
      addLog(db, "dm_read", userId, { otherId:String(otherId) });
      await writeDbAtomic(db);
      emitToUser(String(otherId), "dm_read", { readerId:userId, otherId:String(otherId), readAt: now });
      emitToUser(userId, "dm_counts_changed", {});
    }
  });

  socket.on("disconnect",()=>{
    const set = onlineByUserId.get(userId);
    if(set){
      set.delete(socket.id);
      if(set.size===0) onlineByUserId.delete(userId);
    }
    emitPresence();
  });
});

// Reminder scheduler
setInterval(async ()=>{
  try{
    const db = readDb();
    const now = nowMs();
    let changed=false;
    for(const n of (db.notes||[])){
      if(n.status!=="open" || !n.dueAt) continue;
      const snoozeOk = (!n.snoozeUntil) || (n.snoozeUntil<=now);
      if(!snoozeOk) continue;
      if(n.dueAt<=now){
        if(n.lastTriggeredAt) continue;
        n.lastTriggeredAt = now;
        n.updatedAt = now;
        changed=true;
        for(const aid of (n.assignees||[])){
          emitToUser(aid, "reminder_due",{noteId:n.id});
        }
      }
    }
    if(changed) await writeDbAtomic(db);
  }catch(e){}
}, 4000);

server.listen(PORT, "0.0.0.0", ()=>console.log(`Chat4Office running on http://localhost:${PORT}`));
