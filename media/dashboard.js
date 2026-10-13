const vscode=acquireVsCodeApi();let graph=null;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const renderList=(id,items,kind)=>{document.getElementById(id).innerHTML=items.length?items.map(x=>'<div class="item"><strong>'+esc(x.name||x)+'</strong> <span class="pill">'+esc(x.type||'')+'</span>'+(kind==='topic'?'<div class="muted">Publishers: '+esc((x.publishers||[]).join(', ')||'—')+' · Subscribers: '+esc((x.subscribers||[]).join(', ')||'—')+'</div>':(kind==='service'||kind==='action')?'<div class="muted">Servers: '+esc((x.servers||[]).join(', ')||'—')+' · Clients: '+esc((x.clients||[]).join(', ')||'—')+'</div>':'')+'</div>').join(''):'<div class="item muted">No entries discovered.</div>';};
function drawGraph(g){
 const endpoints=[
  ...g.topics.map(x=>({name:x.name,type:'topic',left:x.publishers||[],right:x.subscribers||[]})),
  ...g.services.map(x=>({name:x.name,type:'service',left:x.clients||[],right:x.servers||[]})),
  ...g.actions.map(x=>({name:x.name,type:'action',left:x.clients||[],right:x.servers||[]}))
 ].filter(x=>x.left.length||x.right.length).slice(0,36);
 const left=[...new Set(endpoints.flatMap(x=>x.left))].slice(0,24);
 const right=[...new Set(endpoints.flatMap(x=>x.right))].slice(0,24);
 const row=38,top=28,height=Math.max(190,Math.max(left.length,right.length,endpoints.length)*row+45),width=1000;
 const ly=new Map(left.map((n,i)=>[n,top+i*row+14])),ry=new Map(right.map((n,i)=>[n,top+i*row+14]));
 const ey=new Map(endpoints.map((x,i)=>[x.name+'|'+x.type,top+i*row+14]));
 let svg='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="ROS 2 node and interface graph">';
 endpoints.forEach(x=>{const y=ey.get(x.name+'|'+x.type);x.left.forEach(n=>{if(ly.has(n))svg+='<path class="edge" d="M 205 '+ly.get(n)+' C 280 '+ly.get(n)+',320 '+y+',395 '+y+'"/>';});x.right.forEach(n=>{if(ry.has(n))svg+='<path class="edge" d="M 605 '+y+' C 680 '+y+',720 '+ry.get(n)+',795 '+ry.get(n)+'"/>';});});
 left.forEach(n=>{const y=ly.get(n);svg+='<rect class="node" x="10" y="'+(y-12)+'" width="195" height="24" rx="4"/><text class="label" x="18" y="'+(y+4)+'">'+esc(n.slice(0,29))+'</text>';});
 endpoints.forEach(x=>{const y=ey.get(x.name+'|'+x.type);svg+='<rect class="'+x.type+'" x="395" y="'+(y-12)+'" width="210" height="24" rx="4"/><text class="label" x="403" y="'+(y+4)+'">'+esc(x.type.toUpperCase()+': '+x.name.slice(0,23))+'</text>';});
 right.forEach(n=>{const y=ry.get(n);svg+='<rect class="node" x="795" y="'+(y-12)+'" width="195" height="24" rx="4"/><text class="label" x="803" y="'+(y+4)+'">'+esc(n.slice(0,29))+'</text>';});
 svg+='<text class="label" x="10" y="15">Publishers / Clients</text><text class="label" x="395" y="15">Topics / Services / Actions</text><text class="label" x="795" y="15">Subscribers / Servers</text></svg>';
 document.getElementById('graph').innerHTML=endpoints.length?svg:'No node-interface relationships were reported by the ROS graph.';
}
function render(g,updated){
 graph=g;document.getElementById('updated').textContent='Updated '+updated;
 const debugEl=document.getElementById('service-debug');
 if(debugEl && Array.isArray(g.diagnostics)){debugEl.textContent=g.diagnostics.join('\\n') || 'Refresh completed; no service diagnostics were produced.';debugEl.scrollTop=debugEl.scrollHeight;}
 document.getElementById('counts').innerHTML=[['Nodes',g.nodes.length],['Topics',g.topics.length],['Services',g.services.length],['Actions',g.actions.length]].map(([n,c])=>'<div class="card"><div class="muted">'+n+'</div><div class="count">'+c+'</div></div>').join('');
 renderList('topic-list',g.topics,'topic');renderList('service-list',g.services,'service');renderList('action-list',g.actions,'action');renderList('node-list',g.nodes.map(name=>({name,type:'node'})),'node');
 const fill=(id,items)=>{const el=document.getElementById(id),old=el.value;el.innerHTML='<option value="">Select…</option>'+items.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+'</option>').join('');if(items.some(x=>x.name===old))el.value=old;};
 fill('echo-topic',g.topics);fill('pub-topic',g.topics);fill('service-select',g.services);fill('action-select',g.actions);
 renderList('overview-services',g.services.slice(0,8),'service');renderList('overview-actions',g.actions.slice(0,8),'action');drawGraph(g);
 document.getElementById('errors').innerHTML=g.errors.length?'<div class="error">'+g.errors.map(esc).join('\n')+'</div>':'';
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.view').forEach(x=>x.hidden=x.id!==b.dataset.tab);}));

document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({command:'refresh'}));
document.getElementById('echo-start').addEventListener('click',()=>vscode.postMessage({command:'startEcho',topic:document.getElementById('echo-topic').value}));
document.getElementById('echo-stop').addEventListener('click',()=>vscode.postMessage({command:'stopEcho'}));
document.getElementById('pub-topic').addEventListener('change',()=>{document.getElementById('pub-new-topic').value='';const topic=graph.topics.find(x=>x.name===document.getElementById('pub-topic').value);if(topic&&topic.type!=='unknown'){document.getElementById('pub-type').value=topic.type;vscode.postMessage({command:'loadTemplate',kind:'msg',type:topic.type});}});
document.getElementById('pub-type').addEventListener('change',()=>vscode.postMessage({command:'loadTemplate',kind:'msg',type:document.getElementById('pub-type').value}));
document.getElementById('pub-start').addEventListener('click',()=>vscode.postMessage({command:'publish',topic:document.getElementById('pub-new-topic').value.trim()||document.getElementById('pub-topic').value,type:document.getElementById('pub-type').value,rate:document.getElementById('pub-rate').value,count:document.getElementById('pub-count').value,yaml:document.getElementById('pub-yaml').value}));
document.getElementById('pub-stop').addEventListener('click',()=>vscode.postMessage({command:'stopPublish'}));
// Keep the selected service type and request template synchronized with the discovered graph.
document.getElementById('service-select').addEventListener('change',()=>{const s=graph.services.find(x=>x.name===document.getElementById('service-select').value);document.getElementById('service-type').textContent='Type: '+(s?s.type:'—');if(s&&s.type!=='unknown')vscode.postMessage({command:'loadTemplate',kind:'srv',type:s.type});});
// Send the selected service and YAML request to the extension host.
document.getElementById('service-call').addEventListener('click',()=>vscode.postMessage({command:'callService',name:document.getElementById('service-select').value,type:graph.services.find(x=>x.name===document.getElementById('service-select').value)?.type,request:document.getElementById('service-request').value}));
document.getElementById('action-select').addEventListener('change',()=>{const a=graph.actions.find(x=>x.name===document.getElementById('action-select').value);document.getElementById('action-type').textContent='Type: '+(a?a.type:'—');if(a&&a.type!=='unknown')vscode.postMessage({command:'loadTemplate',kind:'action',type:a.type});});
document.getElementById('action-send').addEventListener('click',()=>vscode.postMessage({command:'sendGoal',name:document.getElementById('action-select').value,type:graph.actions.find(x=>x.name===document.getElementById('action-select').value)?.type,goal:document.getElementById('action-goal').value}));
document.getElementById('action-cancel').addEventListener('click',()=>vscode.postMessage({command:'cancelGoal'}));
const serviceDebug=document.getElementById('service-debug');
function appendServiceDebug(text){serviceDebug.textContent=(serviceDebug.textContent+'\n'+text).slice(-16000);serviceDebug.scrollTop=serviceDebug.scrollHeight;}
appendServiceDebug('Webview script initialized; waiting for extension-host graph refresh.');
document.querySelector('[data-tab="services"]').addEventListener('click',()=>appendServiceDebug('Services tab opened.'));
window.addEventListener('message',e=>{const m=e.data;
 if(m.command==='serviceDebug'){appendServiceDebug(m.text);}
 else if(m.command==='loading'){document.getElementById('refresh').disabled=m.loading;document.getElementById('refresh').textContent=m.loading?'Refreshing…':'Refresh graph';}
 else if(m.command==='graph'){render(m.graph,m.refreshedAt);}
 else if(m.command==='topicTemplate'){if(m.template!==undefined)document.getElementById('pub-yaml').value=m.template;if(m.error)document.getElementById('pub-output').textContent=m.error;}
 else if(m.command==='serviceTemplate')document.getElementById('service-request').value=m.template||'{}';
 else if(m.command==='actionTemplate')document.getElementById('action-goal').value=m.template||'{}';
 else if(m.command==='echoStatus'){document.getElementById('echo-start').disabled=m.running;document.getElementById('echo-stop').disabled=!m.running;document.getElementById('echo-output').textContent=m.text;}
 else if(m.command==='echoOutput')document.getElementById('echo-output').textContent=(document.getElementById('echo-output').textContent+'\n'+m.text).slice(-12000);
 else if(m.command==='publishStatus'){document.getElementById('pub-start').disabled=m.running;document.getElementById('pub-stop').disabled=!m.running;document.getElementById('pub-output').textContent=m.text;}
 else if(m.command==='publishOutput')document.getElementById('pub-output').textContent=(document.getElementById('pub-output').textContent+'\n'+m.text).slice(-12000);
 else if(m.command==='serviceStatus'){document.getElementById('service-call').disabled=m.running;document.getElementById('service-output').textContent=m.text;}
 else if(m.command==='serviceOutput')document.getElementById('service-output').textContent=(document.getElementById('service-output').textContent+'\n'+m.text).slice(-12000);
 else if(m.command==='actionStatus'){document.getElementById('action-send').disabled=m.running;document.getElementById('action-cancel').disabled=!m.running;document.getElementById('action-output').textContent=m.text;}
 else if(m.command==='actionOutput')document.getElementById('action-output').textContent=(document.getElementById('action-output').textContent+'\n'+m.text).slice(-12000);
 else if(m.command==='operationError'){const id=m.operation==='startEcho'?'echo-output':m.operation==='publish'?'pub-output':m.operation==='callService'?'service-output':m.operation==='sendGoal'?'action-output':'errors';document.getElementById(id).textContent=m.error;}
});
vscode.postMessage({command:'ready'});
