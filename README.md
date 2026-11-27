# veymia-tests

Device tests for [veymia](https://veymia.com) games, a games portal of ZASTECHDEV (SMC-PRIVATE) LIMITED.

This repository holds only the test scripts. They install each game on a real Android emulator and a real Windows machine, then play it automatically. The game source code is private.

How a run works:

1. `scripts/device-test.sh` in the private games repo pushes the builds to a temporary branch here (`builds/...`).
2. It starts the **device tests** workflow.
3. When the tests finish, the workflow deletes the temporary branch. Screenshots and logs stay attached to the run.
