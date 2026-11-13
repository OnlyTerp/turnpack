# Recipe 3: Native Windows Setup (No WSL Required)

Turnpack targets Windows 10/11 directly alongside macOS and Linux:

- Uses Node.js `>= 22` directly (no WSL path translation required).
- Enforces Windows drive-letter & symlink boundary checks in `resolveSafePath`.
- Cleans up timed-out verification process trees cleanly using `taskkill /PID <pid> /T /F`.

Run `npx turnpack demo` and `npx turnpack doctor` directly in PowerShell or Windows Terminal.
