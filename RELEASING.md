# Releasing Streamy

How to put out a new version. Most of the time goes to waiting for the builds
and trying the installers.

## 1. Bump the version

On an up-to-date `main`, with nothing uncommitted:

```sh
npm version 0.2.0
```

This sets the version in `package.json` and `package-lock.json`, commits it,
and creates the tag `v0.2.0`. Use [semantic versioning](https://semver.org):
`0.2.1` for fixes, `0.3.0` for new features.

## 2. Push it

```sh
git push --follow-tags
```

The tag starts the **Release** workflow (the Actions tab on GitHub). It checks
that the tag matches `package.json`, runs the same checks and tests as CI,
builds Streamy on Windows, macOS (Apple silicon and Intel) and Linux, starts
each build once (the smoke test), and puts everything in a **draft** release.
Nobody sees a draft except you.

The Mac builds are made on an Apple silicon runner, so the smoke test can't
start the Intel one. Try the Intel `.dmg` yourself in step 4 (an Intel Mac,
or Rosetta on an Apple silicon Mac).

A version with a hyphen, like `0.2.0-beta.1`, becomes a **pre-release**:
installed copies don't update to it.

If it fails, fix the problem on `main`, then move the tag to the fixed commit
and push it again. The workflow runs again and updates the same draft:

```sh
git tag -f v0.2.0
git push -f origin v0.2.0
```

## 3. Write what's new

Open the draft on the [Releases page](https://github.com/JustArtiom/streamy/releases).
Under **What's new**, write a few lines about what changed, for the people
who use Streamy. The rest of the notes (downloads, first launch, licences) is
already filled in.

## 4. Try the installers

Download them from the draft and try each one (a virtual machine is fine):

- [ ] It installs and opens (after "Open Anyway" on macOS, or "More info →
      Run anyway" on Windows).
- [ ] The title bar looks right and its buttons work.
- [ ] Paste a magnet link: the files show up, and a video plays.
- [ ] Double-click a `.torrent` file: it opens in Streamy.
- [ ] While a video plays, the screen doesn't go to sleep.
- [ ] Settings → Advanced shows the new version, and **Third-party
      licences** opens.
- [ ] Mac: the Intel `.dmg` opens too (see step 2).
- [ ] Windows: turn on **Open magnet links with Streamy**, then click a
      magnet link in a browser. If Windows was told before to always use
      another app, it keeps doing that, even though Streamy's switch says
      on: Windows only lets you change it yourself (Settings → Apps →
      Default apps). Worth knowing when someone reports it.
- [ ] Windows: uninstall Streamy. It may leave its magnet link entry in the
      registry (`HKEY_CURRENT_USER\Software\Classes\magnet`); that's
      harmless (links then do nothing until another app takes them).

## 5. Publish

On the draft, click **Edit**, then **Publish release**. Now it's public.

Then check that updating works. Copies of Streamy only see published
releases, so this comes after publishing:

- [ ] **Windows and Linux AppImage:** open the previous version. It checks
      30 seconds after it starts and downloads the update in the background;
      a few minutes later it says "Streamy 0.2.0 is ready". Click **Restart
      to update**: it closes, installs and opens again, now as 0.2.0.
- [ ] **macOS:** open the previous version. About 30 seconds later it says
      "Streamy 0.2.0 is available", and **Download** opens the release page.

If something's wrong, fix it and release a new version (`0.2.1`). Don't
change a published release.

## Later: code signing

Streamy's installers aren't signed, which is why computers warn about them.

It also means updates aren't checked against a signature. Windows and the
AppImage only check that the download matches the checksum in `latest.yml`,
which comes from the same GitHub release. So whoever can change the releases
on GitHub can ship an update: keep your GitHub account safe (two-factor
login, and don't give others write access to the repository).

**Windows: SignPath Foundation.** It signs open-source projects for free.
Apply at [signpath.org](https://signpath.org). Have ready: the repository
link, a short description of Streamy, its licence (GPL-3.0-or-later), and the
fact that releases are built by GitHub Actions (this workflow). They also ask
for a few things in the project itself, like a short code signing policy in
the README; their site lists the current conditions. Once accepted, a signing
step goes into `release.yml` between building and publishing. One thing to
keep in mind then: `latest.yml` holds the installer's checksum, so it has to
be written after the installer is signed, or updates will fail.

**macOS: Apple Developer Program** (99 USD a year). Signed and notarized, the
Mac app could update itself like the Windows one. That needs: the signing
secrets in GitHub, `notarize: true` in `electron-builder.yml`, the Mac `.zip`
files and one `latest-mac.yml` in each release (the workflow builds the two
Mac CPUs separately, so their two `latest-mac.yml` files must be merged into
one), and macOS switched to "auto" in `src/main/updates/mode.ts`.
