/* ============================================================
   SURVIVING ADAMSVILLE — Report sending configuration
   FILE: github-config.js
   ------------------------------------------------------------
   WHAT THIS FILE DOES:
   Tells the game WHERE to send diagnostic reports (inspector
   findings, stuck vehicles, errors, performance warnings).
   The reports still end up as timestamped files in the
   `reports/` folder of the GitHub repo — but the game no
   longer talks to GitHub itself.

   HOW IT WORKS NOW — THE RELAY (Joshua's ruling, 2026-10-24):
   * Players must NEVER need a GitHub key. Other people will
     play this game, and a key inside a public game file can
     be read by anyone who downloads the game.
   * So the game sends its reports to ONE middleman address —
     the "relay" — with NO key at all. The relay is a small
     Google Apps Script web app running under Joshua's own
     Google account. The relay holds the GitHub key on ITS
     side only (in its private Script Properties) and writes
     each report into the repo's reports/ folder.
   * The only setting that matters is REPORT_RELAY_URL below:
     the relay's web address (it ends in "/exec").
   * Until that address is filled in, sending is OFF: reports
     stay queued on the device and the manual/export behaviour
     is the fallback. No report is lost just because the relay
     address is empty — the queue simply waits.

   There is deliberately NO token setting in this file any
   more. The old direct-to-GitHub upload (token pasted here,
   or stored per-device with GitHubReports.setToken) was
   removed on 2026-10-24 because its token died and because
   shipping any working key in a public game is not safe.
   Do not paste a token here — nothing reads one any more.
   (Two older helpers, crashlog.js and worldfix_sync.js, still
   look for a token in this config / browser storage. With no
   token anywhere they simply stay off, exactly as they have
   since the old token died. Wiring them through the relay is
   a separate job, not part of this file.)
   ------------------------------------------------------------
   Documentation comments are required on all game code —
   Joshua's standing rule. This file follows it.
   ============================================================ */

window.GITHUB_CONFIG = {
  /* The relay's web address. SET THIS to the deployed Google
     Apps Script relay URL (it ends in "/exec") once Joshua has
     finished the one-time relay setup — see
     game-map/report-relay/SETUP.md. The game itself holds
     NO key; this address is not a secret, it is just where
     reports are posted. Leave it "" (empty) until the relay
     exists: reports then stay queued locally, nothing sends. */
  REPORT_RELAY_URL: "",

  /* Client tag sent with every report bundle. This is NOT a
     password and NOT a credential — the relay uses it only to
     ignore random junk posts that are obviously not from the
     game. Anyone who reads this file can read the tag, and
     that is fine: the worst it allows is posting a junk report
     file into the reports/ folder. */
  REPORT_CLIENT_TAG: "surviving-adamsville-game",

  /* Which repo the reports end up in (the relay writes them;
     kept here so every report bundle can name its destination
     and older helpers can still find it). */
  repo: "kingmarkarnold-code/adamsville-play",

  /* Folder inside the repo where the relay writes report files. */
  reportsDir: "reports",

  /* Master switch. Reports only send when this is true AND
     REPORT_RELAY_URL is set. */
  enabled: true,

  /* How often (milliseconds) queued reports are sent in one
     batch. 5 minutes = 300000. */
  flushIntervalMs: 5 * 60 * 1000,

  /* Maximum reports kept in the queue. Oldest are dropped first
     so a long session can never grow memory without bound. */
  maxQueue: 200
};
