/* ============================================================
   SURVIVING ADAMSVILLE — GitHub report upload configuration
   FILE: github-config.js
   ------------------------------------------------------------
   WHAT THIS FILE DOES:
   Lets the game send diagnostic reports (inspector findings,
   stuck vehicles, errors, performance warnings) to your GitHub
   repo as timestamped files in the `reports/` folder, instead of
   only keeping them on the phone.

   HOW TO TURN IT ON (pick ONE option):

   OPTION A — paste your token here (simplest):
     1. On your phone or laptop, open:
        https://github.com/settings/tokens?type=beta
     2. Click "Generate new token".
     3. Token name: "adamsville-game-reports".
     4. Expiration: pick whatever you like (90 days is fine).
     5. Under "Repository access" choose "Only select repositories"
        and pick: kingmarkarnold-code/adamsville-play
     6. Under "Permissions" -> "Repository permissions", set
        "Contents" to "Read and write". Leave everything else
        at "No access".
     7. Click "Generate token", COPY the token (it starts with
        github_pat_...). You only see it once.
     8. Paste it between the quotes on the `token:` line below,
        then tell Mollie "the token is in" so she can push the
        updated file to the repo.

   OPTION B — keep the token OFF the repo (more private):
     1. Do steps 1-7 above to create the token.
     2. Do NOT paste it in this file. Instead, open the game in
        your browser, open the developer console (F12), and run:
            GitHubReports.setToken("paste-your-token-here")
        The token is saved in the browser's own storage on that
        device only — it never goes into the repo or the game files.

   ------------------------------------------------------------
   SECURITY WARNING — READ THIS:
   * Anyone who downloads the game can read this file. If you use
     Option A, they can read your token too.
   * That is why the token must be LIMITED: Contents "Read and
     write" on ONLY the adamsville-play repo, nothing else.
   * Worst case if someone steals it: they can add junk report
     files to your repo. They CANNOT read your other repos,
     delete anything important, or touch your account.
   * If a token ever leaks, delete it at the URL above and make
     a new one. Takes 2 minutes.
   ------------------------------------------------------------
   Documentation comments are required on all game code — Joshua's
   standing rule. This file follows it.
   ============================================================ */

window.GITHUB_CONFIG = {
  /* Paste your fine-grained token between the quotes (Option A),
     or leave empty and use GitHubReports.setToken() (Option B).
     Token placed 2026-10-11 per Joshua's explicit authorization —
     he understands it is visible to anyone who reads this file. */
  token: "",

  /* Which repo receives the reports. Do not change unless you
     move the game to a different repository. */
  repo: "kingmarkarnold-code/adamsville-play",

  /* Folder inside the repo where report files are written. */
  reportsDir: "reports",

  /* Master switch. Reports only upload when this is true AND a
     token is present (from this file or browser storage). */
  enabled: true,

  /* How often (milliseconds) queued reports are uploaded in one
     batch. 5 minutes = 300000. */
  flushIntervalMs: 5 * 60 * 1000,

  /* Maximum reports kept in the queue. Oldest are dropped first
     so a long session can never grow memory without bound. */
  maxQueue: 200
};
