# Streamy

Watch videos from torrents while they download. Paste a magnet link or open a
`.torrent` file, pick a video, and press play. You can skip ahead, choose the
audio and subtitles, and continue later where you left off.

Streamy runs on Windows, macOS and Linux. It's free and open source, and needs
no account. Apart from the torrent traffic itself, it only asks GitHub now and
then whether there's a new version of Streamy. You can turn that off in
Settings → General.

## Download

Get the newest version from the
[Releases page](https://github.com/JustArtiom/streamy/releases/latest):

- **Windows:** `Streamy-<version>-setup.exe`
- **Mac:** `Streamy-<version>-arm64.dmg` for Apple silicon (M1 or newer), or
  `Streamy-<version>-x64.dmg` for Intel
- **Linux:** `Streamy-x86_64.AppImage` (any distribution), or the `.deb`
  (Debian, Ubuntu)

On Windows and with the AppImage, Streamy updates itself. On a Mac, it tells
you when there's a new version to download.

### Opening it the first time

Streamy isn't code-signed yet, so your computer warns you the first time:

- **macOS:** open Streamy. When macOS says it can't check it, click **Done**.
  Then go to **System Settings → Privacy & Security**, scroll down, and click
  **Open Anyway** next to Streamy.
- **Windows:** if SmartScreen says "Windows protected your PC", click **More
  info**, then **Run anyway**.
- **Linux AppImage:** make the file runnable with
  `chmod +x Streamy-*.AppImage` (or tick "Allow executing file as program" in
  its properties), then open it. To open magnet links with Streamy, use the
  `.deb`: the AppImage can't register for them.

## Good to know

While a torrent is active, the other people downloading or sharing it (its
peers) can see your IP address. That's how torrents work. A VPN keeps it
private.

Streamy plays what you give it; it doesn't search for anything. Only watch
what you're allowed to download.

## Building from source

You need [Node.js 24](https://nodejs.org) and Git.

```sh
git clone https://github.com/JustArtiom/streamy.git
cd streamy
npm ci --ignore-scripts        # install the packages, without running their scripts
npm rebuild node-datachannel   # the one package whose script we need (WebRTC)
npm run postinstall            # download Electron
npm run ffmpeg                 # download the ffmpeg that Streamy uses
npm run notices                # list the licences (Settings → Advanced shows them)
npm run dev                    # start Streamy; it reloads as you edit
```

Then:

- `npm test` runs the tests.
- `npm run dist` makes an installer for your computer in `dist/`. On a Mac
  this needs Xcode 26 or newer (for the app icon).

**Ubuntu 24.04 and newer:** `npm run dev` may stop with an error about the
"SUID sandbox". Ubuntu blocks what Electron's sandbox needs; allow it until
the next restart with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or start
it without the sandbox with `npm run dev -- --noSandbox` (only ever for
development).

How releases are made: [RELEASING.md](RELEASING.md).

## License

Streamy: watch videos from torrents while they download.

Copyright (C) 2026 JustArtiom

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
The full text is in [LICENSE](LICENSE).

Streamy includes other people's software, such as Electron and FFmpeg. Their
licences are in the app, under Settings → Advanced → Third-party licences.
