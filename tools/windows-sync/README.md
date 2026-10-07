The repository coordinator uses `17 * * * *` and the watchdog uses `41 * * * *`. GitHub scheduled events may be delayed or dropped. These expressions do not guarantee an hourly execution.

Run `./install-hourly-sync.ps1` in PowerShell to install a separate Windows fallback at minute 37 of every hour. It uses the current user's existing `gh` authentication without storing a token. The task runs while this user is logged in and the computer is available. It checks upstream release identity, skips active workflows or an already successful hourly check, and dispatches the repository coordinator when a check was missed. Missed triggers are caught up when Windows can run them, with a guard around hourly load boundaries.

Every invocation writes `logs/sync-YYYY-MM-DD.jsonl`, including skipped checks and errors. `node ./run-sync.mjs --dry-run` verifies the decision without dispatching. GitHub shows external API dispatches as manually run by the authenticated user.

Disable the fallback with `Disable-ScheduledTask -TaskName Sub2Aouter-HourlySync`. Remove it with `Unregister-ScheduledTask -TaskName Sub2Aouter-HourlySync -Confirm:$false`. An existing task definition is saved as `previous-task.xml` before replacement.
