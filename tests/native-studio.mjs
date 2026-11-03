// Release QA through declared Tauri commands; Windows UI input is exercised with Sky.
import { chromium } from "@playwright/test";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const browser=await chromium.connectOverCDP("http://127.0.0.1:9225");
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("tauri.localhost"));
if(!page)throw new Error("Release WebView not found");
await page.locator('[data-ready="true"]').waitFor();
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const root=path.resolve("reports");await mkdir(root,{recursive:true});
const mode=process.argv[2]??"inspect";
const base=(id,kind,x=0,y=0,extra={})=>({id,kind,x,y,width:240,height:160,color:"#0f6cbd",fill:"#ffffff",strokeWidth:2,opacity:1,createdAt:Date.now(),...extra});
const makeDoc=(id,title,elements)=>{const now=new Date().toISOString();return{schemaVersion:3,id,title,revision:1,createdAt:now,updatedAt:now,elements};};
const restore=async original=>{
  if(!original.document)return;
  // Fetch the newest draft, avoiding replacement of an intervening edit by an old snapshot.
  const fresh=await rpc("open_recent_document",{id:original.document.id});
  if(!fresh.document)throw new Error("Original draft disappeared");
  await rpc("persist_document",{document:fresh.document,path:fresh.path});
};
if(mode==="inspect"){
  const s=await rpc("restore_session");
  console.log(JSON.stringify({title:await page.title(),saved:s.document?{id:s.document.id,schema:s.document.schemaVersion,revision:s.document.revision,objects:s.document.elements.length,path:s.path}:null,fullscreen:await rpc("plugin:window|is_fullscreen",{label:"main"}),ui:await page.evaluate(()=>({timeOrigin:performance.timeOrigin,focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,300),status:document.querySelector(".save-status")?.textContent,meta:document.querySelector(".board-meta")?.textContent,testHook:!!window.__LIGHT_PEN_TEST__,presentation:document.querySelector(".app-shell")?.classList.contains("presentation-mode"),presentationText:document.querySelector(".presentation-controls")?.textContent}))},null,2));
}else if(mode==="keyboard-observe"){
  // Observation only: the physical Windows input is sent separately by Sky.
  console.log("WAITING_FOR_SKY_KEY");
  console.log(JSON.stringify(await page.evaluate(()=>new Promise(resolve=>{
    const onKey=e=>{clearTimeout(timer);resolve({key:e.key,code:e.code,keyCode:e.keyCode,trusted:e.isTrusted});};
    const timer=setTimeout(()=>{window.removeEventListener("keydown",onKey,true);resolve({timeout:true});},15000);
    window.addEventListener("keydown",onKey,{once:true,capture:true});
  }))));
}else if(mode==="export"){
  const chunk=(await readdir(path.resolve("dist/assets"))).find(n=>n.startsWith("vector-export-")&&n.endsWith(".js"));
  assert(chunk);const svgOut=path.join(root,"Скомпилированный экспорт 0.3.svg"),pdfOut=path.join(root,"Скомпилированный экспорт 0.3.pdf");
  const report=await page.evaluate(async({chunk,svgOut,pdfOut})=>{
    const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
    const {document:doc}=await invoke("restore_session",{});
    const {exportSvg,exportPdf}=await import("/assets/"+chunk);
    const svg=await exportSvg(doc),pdf=await exportPdf(doc,{frames:doc.elements.filter(e=>e.kind==="frame")});
    let binary="";for(let i=0;i<pdf.length;i+=8192)binary+=String.fromCharCode(...pdf.subarray(i,i+8192));
    await invoke("export_vector",{path:svgOut,format:"svg",data:svg.svg});
    await invoke("export_vector",{path:pdfOut,format:"pdf",data:btoa(binary)});
    return{title:doc.title,objects:doc.elements.length,svgCharacters:svg.svg.length,pdfBytes:pdf.length,frames:doc.elements.filter(e=>e.kind==="frame").length,fontsLoaded:document.fonts.check("16px LightPenExport")};
  },{chunk,svgOut,pdfOut});
  assert((await readFile(pdfOut)).subarray(0,5).toString()==="%PDF-");
  assert((await readFile(svgOut,"utf8")).includes("data:font/ttf;base64,"));
  await writeFile(path.join(root,"native-v3-compiled-export.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}else if(mode==="backup"){
  const s=await rpc("restore_session");if(!s.document)throw new Error("No original board");
  const target=path.resolve("boards","Перед обновлением до 0.3.lightpen");await mkdir(path.dirname(target),{recursive:true});
  await copyFile(path.join(process.env.APPDATA,"app.lightpen.desktop","drafts",s.document.id+".lightpen"),target,constants.COPYFILE_EXCL);
  const report={id:s.document.id,title:s.document.title,objects:s.document.elements.length,revision:s.document.revision,path:s.path,backup:target};
  await writeFile(path.join(root,"native-v3-original.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}else if(mode==="backend"){
  const original=await rpc("restore_session"),checks=[];const check=name=>{checks.push(name);console.log("PASS "+name);};
  const id="native-v3-qa-"+crypto.randomUUID(),target=path.join(root,"Нативная доска 0.3 日本語.lightpen");
  const doc=makeDoc(id,"Проверка 0.3 日本語",[
    base("table","table",0,0,{text:"Расчёт",fontSize:18,cells:[["Этап","Срок"],["Тест","Сегодня"]],rotation:25,name:"Таблица проекта",hidden:false}),
    base("task","task",350,0,{text:"Проверить",fontSize:18,task:{status:"doing",due:"2026-11-09",items:[{id:"first",text:"Проверить сохранение ✓",done:true}]}}),
    base("link","link",700,0,{text:"Связь",fontSize:18,link:{path:target,elementId:"table",label:"К таблице"}}),
    base("arrow","arrow",240,80,{width:110,height:0,endX:110,endY:0,connectorStyle:"orthogonal",label:"Следующий шаг",fontSize:18,route:[{x:0,y:0},{x:55,y:0},{x:55,y:20},{x:110,y:20}],startBinding:{elementId:"table",side:"right"},endBinding:{elementId:"task",side:"left"}}),
    base("ink","stroke",0,300,{points:Array.from({length:10000},(_,i)=>[i*.2,Math.sin(i*.015)*50,.1+(i%80)/100,i*.5]),ink:{smoothing:65,stabilization:55,minWidth:40,pressure:100}}),
    ...Array.from({length:10000},(_,i)=>base("load-"+i,"rectangle",(i%100)*160,500+Math.floor(i/100)*110,{width:110,height:65})),
  ]);
  let saveMs,readMs,bytes;
  try{
    let start=performance.now();await rpc("persist_document",{document:doc,path:target});saveMs=performance.now()-start;
    start=performance.now();const loaded=await rpc("open_document",{path:target});readMs=performance.now()-start;assert.deepEqual(loaded,doc);check("format 3, 10005 objects and 10000 pressure samples round trip");
    bytes=await readFile(target);assert.equal(bytes.subarray(0,15).toString(),"SQLite format 3");check("SQLite container and Unicode path");
    await rpc("create_checkpoint",{document:doc});const versions=await rpc("list_versions",{id}),v=versions.find(v=>v.manual);assert(v);assert.deepEqual(await rpc("read_version",{id,version:v.id}),doc);check("persistent version contains structured objects");
    const template=makeDoc("template-"+crypto.randomUUID(),"Пример задачи и таблицы",doc.elements.slice(0,5));
    await rpc("save_template",{document:template});const summary=(await rpc("list_templates")).find(t=>t.id===template.id);assert(summary);assert.equal(summary.objects,5);assert(summary.elements.every(e=>!e.points&&!e.cells&&!e.task&&!e.link));assert.deepEqual(await rpc("read_template",{id:template.id}),template);check("lightweight template list and complete readback");
    const portable=path.join(root,"Переносимый шаблон 0.3.lightpen-template");await rpc("export_template",{path:portable,document:template});assert.deepEqual(await rpc("open_document",{path:portable}),template);check("portable template container round trip");
    const invalid=structuredClone(doc);invalid.elements[0].cells=[["a"],["b","c"]];await assert.rejects(()=>rpc("persist_document",{document:invalid,path:target}));assert.deepEqual(await readFile(target),bytes);check("invalid table cannot replace saved bytes");
    invalid.elements[0]=structuredClone(doc.elements[0]);invalid.elements[1].task.status="invalid";await assert.rejects(()=>rpc("persist_document",{document:invalid,path:target}));assert.deepEqual(await readFile(target),bytes);check("invalid task cannot replace saved bytes");
    await assert.rejects(()=>rpc("read_template",{id:"../outside"}));await assert.rejects(()=>rpc("remove_template",{id:"..\\outside"}));check("template identifiers cannot escape library");
    const svg=await readFile(path.join(root,"v3-vector.svg"),"utf8"),pdf=await readFile(path.join(root,"v3-frames.pdf"));
    const svgOut=path.join(root,"Нативный экспорт.svg"),pdfOut=path.join(root,"Нативный экспорт.pdf");
    await rpc("export_vector",{path:svgOut,format:"svg",data:svg});await rpc("export_vector",{path:pdfOut,format:"pdf",data:pdf.toString("base64")});assert.equal(await readFile(svgOut,"utf8"),svg);assert.deepEqual(await readFile(pdfOut),pdf);check("SVG and PDF native atomic export retains exact bytes");
    await assert.rejects(()=>rpc("export_vector",{path:pdfOut,format:"pdf",data:Buffer.from("invalid").toString("base64")}));assert.deepEqual(await readFile(pdfOut),pdf);check("invalid export preserves existing output");
    await assert.rejects(()=>rpc("open_local_file",{path:path.join(root,"nonexistent-local-file.pdf")}));check("missing local file reports an error");
  }finally{await restore(original);}
  const restored=await rpc("restore_session");assert.equal(restored.document.id,original.document.id);check("fresh original draft restored after all API tests");
  await writeFile(path.join(root,"native-v3-api-report.json"),JSON.stringify({checks,saveMs,readMs,bytes:bytes.length,objects:doc.elements.length,pressureSamples:10000,originalObjects:restored.document.elements.length},null,2));
  console.log(JSON.stringify({checks:checks.length,saveMs,readMs,bytes:bytes.length}));
}else if(mode==="demo"){
  const original=await rpc("restore_session"),demoPath=path.resolve("boards","Light Pen 0.3 — новые инструменты.lightpen"),linkedPath=path.resolve("boards","Связанная доска Light Pen.lightpen");
  const {renderFormula}=await import("../src/editor/render/math.ts");
  const source=String.raw`E=mc^2\qquad\int_0^1 x^2\,dx=\frac13`,math=renderFormula(source,"#0f6cbd",32);
  const doc=makeDoc("light-pen-v3-demo","Light Pen 0.3 — новые инструменты",[
    base("frame-plan","frame",0,0,{width:1100,height:760,text:"План проекта",fontSize:20,fill:"transparent",color:"#8a8a8a",slideOrder:0}),
    base("frame-result","frame",1220,0,{width:1050,height:760,text:"Результат и формулы",fontSize:20,fill:"transparent",color:"#8a8a8a",slideOrder:1}),
    base("title","text",50,65,{width:1000,height:62,text:"Больше возможностей. Меньше панелей.",fontSize:34,bold:true,fill:"transparent",color:"#242424"}),
    base("intro","text",50,140,{width:970,height:56,text:"Объекты, вставка и свойства сменяют друг друга слева.\nМиникарту можно свернуть, а фреймы — показать как презентацию.",fontSize:20,fill:"transparent",color:"#616161"}),
    base("task-demo","task",50,260,{width:340,height:260,text:"Подготовить идею",fontSize:20,task:{status:"doing",due:"2026-11-09",items:[{id:"one",text:"Собрать заметки",done:true},{id:"two",text:"Нарисовать схему",done:false},{id:"three",text:"Показать результат",done:false}]}}),
    base("table-demo","table",610,260,{width:430,height:210,text:"План",fontSize:18,cells:[["Этап","Результат"],["Идея","Стикеры и схема"],["Проверка","Сохранить и открыть"],["Показ","PDF и презентация"]]}),
    base("connector-demo","arrow",390,380,{width:220,height:0,endX:220,endY:0,fill:"transparent",connectorStyle:"curve",fontSize:18,label:"Следующий шаг",startBinding:{elementId:"task-demo",side:"right"},endBinding:{elementId:"table-demo",side:"left"}}),
    base("note-demo","sticky",55,590,{width:340,height:110,text:"Сохраните фрагмент как шаблон",fontSize:22,fill:"#fff1a8",color:"#242424",rotation:-5}),
    base("link-demo","link",610,565,{width:430,height:110,text:"Связанная доска",fontSize:22,link:{path:linkedPath,elementId:"linked-note",label:"Открыть связанную доску"}}),
    base("math-title","text",1280,85,{width:920,height:60,text:"Точный текст и формулы",fontSize:34,bold:true,fill:"transparent",color:"#242424"}),
    base("math-demo","math",1300,230,{width:math.width,height:math.height,text:source,fontSize:32,fill:"transparent"}),
    base("export-note","sticky",1280,390,{width:430,height:220,text:"Двойной щелчок редактирует содержимое.\n\nF5 — презентация фреймов.\nEsc — вернуться к доске.",fontSize:24,color:"#242424",fill:"#cfe9fd"}),
    base("back-to-plan","link",1770,420,{width:430,height:110,text:"План проекта",fontSize:22,link:{path:"",elementId:"frame-plan",label:"К плану проекта"}}),
  ]);
  const linked=makeDoc("light-pen-v3-linked-demo","Связанная доска Light Pen",[
    base("linked-note","sticky",100,100,{width:520,height:260,text:"Это отдельная локальная доска.\n\nСсылки ведут к файлам, фреймам\nи конкретным объектам.",fontSize:26,fill:"#d7efd9",color:"#242424"}),
    base("back","link",100,430,{width:520,height:110,text:"Назад",fontSize:22,link:{path:demoPath,elementId:"frame-plan",label:"Вернуться к примеру"}}),
  ]);
  await mkdir(path.dirname(demoPath),{recursive:true});
  try{await rpc("persist_document",{document:linked,path:linkedPath});await rpc("persist_document",{document:doc,path:demoPath});}finally{await restore(original);}
  console.log(JSON.stringify({demoPath,linkedPath,objects:doc.elements.length}));
}else throw new Error("Unknown mode");
await browser.close();
