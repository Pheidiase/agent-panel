// Send retained history in bounded pages, waiting for each frame to drain.
// The viewer is subscribed with replaying=true: events arriving during a send
// are read from the log on the next pass, before live delivery takes over.
export async function replayEvents(client, read, after = 0) {
  for (;;) {
    if (client.ws.readyState !== 1) return;
    const page = read({ after, page: true });
    if (!page.events.length && !page.truncated) {
      client.replaying = false;
      return;
    }
    await new Promise((resolve, reject) => {
      client.ws.send(JSON.stringify({ type: "events", ...page }), error => error ? reject(error) : resolve());
    });
    if (!page.events.length) {
      client.replaying = false;
      return;
    }
    after = page.lastSeq;
  }
}
