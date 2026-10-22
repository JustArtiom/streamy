## What's new

<!-- Write a few lines about what changed before you publish this draft. -->

## Download

| Your computer                        | Download                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| Windows 10 or 11                     | `Streamy-{{version}}-setup.exe`                                    |
| Mac with Apple silicon (M1 or newer) | `Streamy-{{version}}-arm64.dmg`                                    |
| Mac with an Intel processor          | `Streamy-{{version}}-x64.dmg`                                      |
| Linux                                | the `.AppImage` (any distribution), or the `.deb` (Debian, Ubuntu) |

## Opening it the first time

Streamy isn't code-signed yet, so your computer warns you the first time you open it. That's expected. Here's how to get past it:

- **macOS:** open the `.dmg` and drag Streamy into Applications, then open it. macOS says it can't check Streamy: click **Done**. Then open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Streamy.
- **Windows:** if SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux AppImage:** make it runnable with `chmod +x Streamy-*.AppImage` (or tick "Allow executing file as program" in its properties), then open it.

## Updates

On Windows and with the Linux AppImage, Streamy updates itself: it downloads new versions in the background and installs them when you restart it. On macOS, Streamy tells you when there's a new version, and you download it from here. To update the `.deb`, install the new `.deb`.

## Source code and licences

Streamy is free software under the GNU GPL, version 3 or later. Its source code is in this repository, at the tag `v{{version}}`.

Streamy includes ffmpeg and ffprobe from {{ffmpeg.name}} {{ffmpeg.version}} (FFmpeg {{ffmpeg.ffmpegVersion}}), unmodified, also under the GNU GPL version 3 or later. Their complete source code is attached to this release as `{{ffmpeg.sourceAsset}}`. It's also at {{ffmpeg.sourceUrl}} (tag `{{ffmpeg.tag}}`, commit `{{ffmpeg.commit}}`).

The licences of everything else inside Streamy are in the app, under **Settings → Advanced → Third-party licences**.
