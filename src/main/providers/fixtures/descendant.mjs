// An external child deliberately stays alive after its provider parent exits.
process.send('ready');
setInterval(() => {}, 60_000);
