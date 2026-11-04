import { jsonValue } from "./validation";
import type {
  HostCall,
  JSONValue,
  PluginPackage,
  PluginRuntime,
} from "./types";

// This fixed, trusted loader is the only script ever run in the iframe. Plugin
// source travels over a MessagePort and is executed exclusively in its Worker.
export const FRAME_BOOTSTRAP = String.raw`(()=>{"use strict";let port,worker,url;addEventListener("message",e=>{if(port||e.source!==parent||e.data?.type!=="lightpen-plugin-init"||!e.ports[0]||typeof e.data.workerCode!=="string")return;port=e.ports[0];try{url=URL.createObjectURL(new Blob([e.data.workerCode],{type:"text/javascript"}));worker=new Worker(url);URL.revokeObjectURL(url);worker.onmessage=e=>port.postMessage(e.data);worker.onerror=e=>port.postMessage({kind:"fatal",error:String(e.message).slice(0,1000)});port.onmessage=e=>{if(e.data?.kind==="stop"){worker.terminate();port.close();return;}worker.postMessage(e.data);};port.start();}catch(e){port.postMessage({kind:"fatal",error:String(e).slice(0,1000)});}});parent.postMessage({type:"lightpen-plugin-frame-ready"},"*");})();`;

const WORKER_PRELUDE = String.raw`"use strict";
(()=>{
 const send=postMessage.bind(globalThis),waiting=new Map();let serial=0,handlers={},running=false;
 for(const name of ["Worker","SharedWorker"]){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});}catch{}}
 const call=(method,args={})=>new Promise((resolve,reject)=>{const id=++serial;waiting.set(id,{resolve,reject});send({kind:"call",id,method,args});});
 const sdk=Object.freeze({
  register(commands){if(running||!commands||typeof commands!=="object")throw Error("Invalid command registration");handlers=commands;},
  board:Object.freeze({read:(options={})=>call("board.read",options),apply:changes=>call("board.apply",changes)}),
  widgets:Object.freeze({create:widget=>call("widgets.create",widget)}),
  storage:Object.freeze({get:key=>call("storage.get",{key}),set:(key,value)=>call("storage.set",{key,value})}),
  network:Object.freeze({fetch:(url,options={})=>call("network.fetch",{url,...options})}),
  files:Object.freeze({read:path=>call("files.read",{path}),write:(path,data,overwrite=false)=>call("files.write",{path,data,overwrite})}),
  ui:Object.freeze({notify:message=>call("ui.notify",{message})})
 });
 Object.defineProperty(globalThis,"LightPen",{value:sdk,writable:false,configurable:false});
 addEventListener("message",async e=>{const m=e.data;if(m?.kind==="reply"){const p=waiting.get(m.id);if(p){waiting.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}return;}
 if(m?.kind!=="invoke"||running)return;running=true;try{const fn=Object.hasOwn(handlers,m.command)&&handlers[m.command];if(typeof fn!=="function")throw Error("Command handler not registered");const result=await fn(m.args);send({kind:"result",result:result===undefined?null:result});}catch(e){send({kind:"error",error:String(e?.message??e).slice(0,2000)});}finally{running=false;}});
})();
`;

export async function frameHash() {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(FRAME_BOOTSTRAP),
  );
  return "sha256-" + btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
export function workerSource(code: string) {
  return WORKER_PRELUDE + "\n" + code + '\n;postMessage({kind:"ready"});\n';
}

export class SandboxRuntime implements PluginRuntime {
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private abort: (() => void) | null = null;
  private listener: ((event: MessageEvent) => void) | null = null;
  private used = false;
  private stopped = false;
  constructor(
    private bundle: PluginPackage,
    private timeoutMs = 8000,
  ) {}
  async invoke(
    command: string,
    args: JSONValue,
    call: HostCall,
  ): Promise<JSONValue> {
    if (this.used) throw Error("Plugin runtime already used");
    this.used = true;
    const hash = await frameHash();
    if (this.stopped) throw Error("PLUGIN_DISABLED");
    return new Promise<JSONValue>((resolve, reject) => {
      let settled = false,
        calls = 0,
        inflight = 0;
      const done = (error: Error | null, result: JSONValue = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.abort = null;
        this.dispose();
        error ? reject(error) : resolve(result);
      };
      const timeout = setTimeout(
        () => done(Error("PLUGIN_TIMEOUT: extension was stopped")),
        this.timeoutMs,
      );
      this.abort = () => done(Error("PLUGIN_DISABLED: extension was stopped"));
      const frame = document.createElement("iframe");
      this.frame = frame;
      frame.hidden = true;
      frame.title = "Изолированное расширение " + this.bundle.manifest.name;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute(
        "allow",
        "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; hid 'none'",
      );
      frame.referrerPolicy = "no-referrer";
      this.listener = (event) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.type !== "lightpen-plugin-frame-ready" ||
          this.port
        )
          return;
        const channel = new MessageChannel();
        this.port = channel.port1;
        channel.port1.onmessage = async ({ data: message }) => {
          if (settled) return;
          try {
            jsonValue(message);
            if (message.kind === "ready") {
              channel.port1.postMessage({ kind: "invoke", command, args });
            } else if (message.kind === "fatal" || message.kind === "error") {
              done(Error(String(message.error).slice(0, 2000)));
            } else if (message.kind === "result") {
              if (inflight)
                throw Error(
                  "Await every host API call before returning a result",
                );
              done(null, jsonValue(message.result));
            } else if (message.kind === "call") {
              if (
                ++calls > 100 ||
                ++inflight > 16 ||
                !Number.isSafeInteger(message.id) ||
                typeof message.method !== "string" ||
                !message.args ||
                typeof message.args !== "object" ||
                Array.isArray(message.args)
              )
                throw Error("PLUGIN_LIMIT: too many or invalid host requests");
              try {
                const result = jsonValue(
                  await call(message.method, message.args),
                );
                if (!settled)
                  channel.port1.postMessage({
                    kind: "reply",
                    id: message.id,
                    result,
                  });
              } catch (error) {
                if (!settled)
                  channel.port1.postMessage({
                    kind: "reply",
                    id: message.id,
                    error: String(
                      error instanceof Error ? error.message : error,
                    ).slice(0, 2000),
                  });
              } finally {
                inflight--;
              }
            } else throw Error("Unknown plugin message");
          } catch (error) {
            done(error instanceof Error ? error : Error(String(error)));
          }
        };
        channel.port1.start();
        frame.contentWindow!.postMessage(
          {
            type: "lightpen-plugin-init",
            workerCode: workerSource(this.bundle.code!),
          },
          "*",
          [channel.port2],
        );
      };
      window.addEventListener("message", this.listener);
      const csp = `default-src 'none'; script-src '${hash}'; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${FRAME_BOOTSTRAP}</script>`;
      document.body.append(frame);
    });
  }
  stop() {
    this.stopped = true;
    this.abort?.();
    this.dispose();
  }
  private dispose() {
    if (this.listener) window.removeEventListener("message", this.listener);
    this.listener = null;
    this.port?.postMessage({ kind: "stop" });
    this.port?.close();
    this.port = null;
    this.frame?.remove();
    this.frame = null;
  }
}
