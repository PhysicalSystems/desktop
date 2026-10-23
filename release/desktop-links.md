# Website launch link

The public desktop installer registers `physicalsystems://open` with the operating
system. The website can offer this link from an explicit **Open desktop app**
action and keep its download page available if the app is not installed.
Candidate and unpacked review builds do not register the public protocol.

The link only opens or raises Physical Systems. A running minimized window is
restored and focused. A cold launch follows normal startup and window restoration;
it does not select a different project or conversation. Requests received during
startup are coalesced until an existing startup window is ready.

Only the exact URI above is accepted. Paths, trailing slashes, query strings,
fragments, credentials and workcell routes are unsupported. The main process
consumes these requests without forwarding them to the renderer, and the URI
cannot submit a prompt, connect a device, or transfer account credentials.

The protocol becomes available when a public installer containing its registration
is installed. Updating the website alone does not register a handler for older
installations. The internal renderer protocol and the separate `opencode://`
handler are unrelated to this launch contract.
