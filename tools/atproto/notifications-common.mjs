// Shared by notifications*.mjs.
export const argValue = (name) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);

// One unread notification: { service, time, reason, handle, did, uri, subject, text, url }.
export function printNotification(n, asJson) {
  if (asJson) console.log(JSON.stringify(n));
  else console.log(`${n.time}  ${n.reason.padEnd(9)} ${n.handle}${n.text ? `\n    ${n.text.replace(/\s+/g, ' ')}` : ''}${n.url ? `\n    ${n.url}` : ''}`);
}
