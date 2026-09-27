// Audit the index, not the deployment directory. Never print a matched secret.
import { execFileSync } from "node:child_process";
const entries = execFileSync("git", ["ls-files","--stage","-z"], {encoding:"utf8"}).split("\0").filter(Boolean);
const errors = [];
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["cloud access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/]
];
for (const entry of entries) {
  const [,mode,oid,stage,path] = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/) || [];
  if (!path) { errors.push("Invalid index entry");continue; }
  if (mode === "120000" || stage !== "0") errors.push(path+": symlink or unresolved merge");
  if (/^(?:data|runtime[^/]*|workspaces|vendor|downloads|backups|apps|build)\//.test(path)
    || /(^|\/)(?:node_modules|\.venv|__pycache__)\//.test(path)
    || /(?:\.session-map\.json|\.(?:log|db|sqlite3?|pid|sock|pyc))$/.test(path)
    || (path.startsWith("config/") && (path.endsWith(".plist") || path === "config/qq-only.env"))
    || /(^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith(".example")) {
    errors.push(path+": forbidden deployment state");
  }
  const data = execFileSync("git",["cat-file","blob",oid]);
  if (path.endsWith(".png")) {
    if (data.subarray(0,8).toString("hex") !== "89504e470d0a1a0a") { errors.push(path+": invalid PNG");continue; }
    for (let offset=8;offset+12<=data.length;) {
      const size=data.readUInt32BE(offset),type=data.subarray(offset+4,offset+8).toString();
      if (offset+12+size>data.length) {errors.push(path+": malformed PNG");break;}
      if (["eXIf","tEXt","zTXt","iTXt"].includes(type)) errors.push(path+": image metadata needs review");
      offset+=12+size;
    }
    continue;
  }
  if (data.includes(0)) {errors.push(path+": unexpected binary");continue;}
  const text=data.toString("utf8");
  for (const [label,regex] of secretPatterns) if (regex.test(text)) errors.push(path+": possible "+label);
}
if (!entries.length) errors.push("Index is empty: stage the reviewed release before auditing");
if (errors.length) {console.error(errors.join("\n"));process.exitCode=1;}
else console.log("Public index audit passed: "+entries.length+" files; no deployment state, recognized credentials or PNG metadata.");
