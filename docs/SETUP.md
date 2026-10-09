# Setup: from zero to the Phase 0, 1 and 2 gates

This guide takes you from a fresh Windows PC and an Android phone to the Phase 0 gate passing:

> **A row created offline on the phone appears in Postgres after reconnecting.**

Do the sections in order. Each step says what to run, what success looks like, and what it costs.
Commands are for **PowerShell** on Windows unless a step says otherwise. Anything marked **verify**
could not be checked against the vendor's live page when this was written (2026-10-08); if a button
or a limit looks different, trust the vendor's page.

Plan on an afternoon for sections 1–8 and an hour or two for the first build.

**Phase 1 (the core loop)** adds one database migration, a new app build and a new gate: a study →
lift → study cycle in airplane mode. Those steps are in
[section 16](#16-phase-1-the-core-loop-on-your-phone).

**Phase 2 (the study engine)** adds settings on Render and GitHub, a **Deploy backend** workflow
that sets up the database and the server functions for you, a new app build, and a new gate: a
course PDF and handwritten notes become one plan, then a week of reviews. Those steps are in
[section 17](#17-phase-2-the-study-engine-on-your-phone).

## What it costs

Everything in Phase 0 and Phase 1 runs on free tiers. Phase 2 adds pay-per-use AI calls (about
$1–3 for the gate on the default model): see
[What Phase 2 costs each month](#what-phase-2-costs-each-month).

| Service | What you use it for | Phase 0 cost | Notes |
|---|---|---|---|
| GitHub | Code, CI, the APK build | Free | Private repos get a monthly allowance of Actions minutes; the APK build is the heaviest job (**verify** your usage under Settings → Billing) |
| Expo (EAS) | Cloud builds | Free plan | A limited number of cloud builds per month, in a slower queue (**verify** at expo.dev/pricing). Local builds and the GitHub APK cost nothing. |
| Supabase | Postgres, Auth, the Data API | Free plan | Free projects can be paused after a stretch of inactivity (**verify** the current rule); restoring one is a click in the dashboard |
| PowerSync Cloud | Sync between the phone and Postgres | Free plan | $0: 2 GB synced per month, 500 MB hosted, 50 connections at once, 2 instances. **A free instance is removed after 7 days with no deploys and no app connections.** (From search excerpts: **verify** at powersync.com/pricing.) Pro starts at $49/month. |
| Android Studio, JDK, Node.js, Git | Your PC | Free | |
| Google Play Console | Publishing (later) | One-time fee (**verify** the amount) | Not needed for the Phase 0 gate |

Keep these in a password manager (Bitwarden's free plan is fine): the Supabase database password,
the PowerSync role password, from Phase 2 the Tracy secret
([§17](#before-you-start-the-secrets-in-this-phase)), and later the Play service-account key. **None
of them ever goes into git, into the app, or into a chat.**

---

## 1. Create your accounts

1. **GitHub.** You have it. The repo is `https://github.com/FabianB14/DualRep`.
2. **Expo.** Sign up at https://expo.dev/signup. Pick a username you're happy to see in build URLs.
3. **Supabase.** Sign up at https://supabase.com/dashboard (signing in with GitHub is easiest).
   - Use an email address you can read **on your phone**. Until a custom email sender is set up,
     Supabase's built-in sender only delivers sign-in emails to members of your Supabase team, so
     this is the address you will sign in to DualRep with.
4. **PowerSync.** Sign up at https://dashboard.powersync.com.
5. **Google Play Console: decide, don't buy yet.** Not needed for the gate, but one choice has a long
   lead time: a **personal** account means a 12-tester, 14-day closed test before launch; an
   **organization** account needs a free D-U-N-S number that can take up to 28 days. Read
   [ANDROID.md §0.5](ANDROID.md#05-play-console-account-decide-now) and pick one this week.

**Success:** you can log in to expo.dev, the Supabase dashboard and the PowerSync dashboard.

---

## 2. Set up your Windows PC

Every path needs Node.js, Git and **adb** (the tool that talks to your phone over USB; sections 3,
10 and 11 use it). Java and Android Studio (steps 3 and 4) are only for **local** builds
([path B](#path-b-build-on-your-pc)). If you will only use EAS cloud builds or the GitHub APK, skip
steps 3 and 4, and in step 5 follow **"Paths A and C: adb on its own"** instead.

### Step 1: Node.js 22 LTS
1. Download the **Node.js 22** Windows installer (`.msi`) from https://nodejs.org/en/download. CI uses
   Node 22; the repo needs **22.13 or newer**.
2. Run it with the defaults.
3. Open a **new** PowerShell window and check:
   ```powershell
   node -v   # v22.13.0 or newer
   npm -v
   ```

### Step 2: Git, with long paths on
1. Install Git for Windows from https://git-scm.com/download/win (defaults are fine).
2. Turn on long paths in Git:
   ```powershell
   git config --global core.longpaths true
   ```
3. Turn on long paths in Windows. Open PowerShell **as Administrator** (right-click → Run as
   administrator) and run:
   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```
   Restart Windows afterwards.

**Why:** the native Android build (CMake and Ninja under React Native's New Architecture) creates very
deep folder paths. Past 260 characters, Windows builds fail with confusing errors.

### Step 3: JDK 17
React Native 0.86's Gradle plugin requires a **Java 17** toolchain. A newer JDK alone is not enough.

1. Install the **Microsoft Build of OpenJDK 17** (`.msi` for x64) from
   https://learn.microsoft.com/java/openjdk/download. In the installer, turn on **Set JAVA_HOME
   variable**. (Missed it? Run
   `[Environment]::SetEnvironmentVariable('JAVA_HOME', '<the JDK 17 folder>', 'User')`, for example
   `C:\Program Files\Microsoft\jdk-17…`.)
2. New PowerShell window:
   ```powershell
   java -version        # openjdk version "17.x"
   echo $env:JAVA_HOME  # the JDK 17 folder
   ```

### Step 4: Android Studio and the SDK parts
1. Install Android Studio from https://developer.android.com/studio and run its setup wizard with the
   **Standard** options (it installs the Android SDK).
2. Open **More Actions → SDK Manager** (or **Settings → Languages & Frameworks → Android SDK**).
3. **SDK Platforms** tab: tick **Android 16 (API 36)** → "Android SDK Platform 36".
4. **SDK Tools** tab: tick **Show Package Details** (bottom right), then tick exactly these:
   - **Android SDK Build-Tools** → **36.0.0**
   - **NDK (Side by side)** → **27.1.12297006**
   - **CMake** → **3.30.5**
   - **Android SDK Platform-Tools**
   - **Android SDK Command-line Tools (latest)**
   - **Android Emulator** (optional; you'll use your phone)
5. Click **Apply** and wait for the downloads.

These are the versions Expo SDK 57 / React Native 0.86 build with (the same list the CI APK build
installs).

### Step 5: ANDROID_HOME and PATH
**Path B (you installed Android Studio in step 4).** Run in a normal PowerShell window:
```powershell
[Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$userPath;$env:LOCALAPPDATA\Android\Sdk\platform-tools", 'User')
```
Close PowerShell, open a new one, and check:
```powershell
echo $env:ANDROID_HOME   # C:\Users\<you>\AppData\Local\Android\Sdk
adb version              # Android Debug Bridge version 1.0.41 (or similar)
```
(Prefer clicking? Start → "Edit environment variables for your account" does the same.)

**Paths A and C: adb on its own** (no Android Studio):
1. Open https://developer.android.com/tools/releases/platform-tools, click **Download SDK
   Platform-Tools for Windows** and accept the terms. It saves `platform-tools-latest-windows.zip` in
   your Downloads folder.
2. In a normal PowerShell window, unzip it to `C:\platform-tools` and add that folder to your PATH:
   ```powershell
   Expand-Archive "$env:USERPROFILE\Downloads\platform-tools-latest-windows.zip" -DestinationPath C:\ -Force
   $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
   [Environment]::SetEnvironmentVariable('Path', "$userPath;C:\platform-tools", 'User')
   ```
3. Close PowerShell, open a new one, and check:
   ```powershell
   adb version              # Android Debug Bridge version 1.0.41 (or similar)
   ```

### Step 6: A short folder for code
Keep the repo at a **short path outside OneDrive**, for example `C:\dev\dualrep`. OneDrive syncing
`node_modules` and Gradle caches slows everything down, and a deep path brings back the 260-character
problem.

### Step 7: Command-line tools for the services
```powershell
npm install --global eas-cli
eas --version            # eas-cli/24.x or newer
```
The Supabase and PowerSync command-line tools run through `npx`, so there is nothing else to install:
```powershell
npx supabase --version   # first run downloads it; prints 2.x
npx powersync --version  # PowerSync CLI (beta); prints 0.10.x or newer
```
If `npx supabase` doesn't work on your PC, install the Supabase CLI with Scoop instead (**verify**
against Supabase's install docs):
```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```
Then type `supabase` wherever this guide says `npx supabase`.

**Success for section 2:** `node -v`, `git --version`, `adb version` and `eas --version` all print
versions in a new PowerShell window, and on path B `java -version` prints 17.

---

## 3. Set up your Android phone

1. **Developer options:** Settings → About phone → tap **Build number** 7 times. (On some brands it is
   under About phone → Software information.)
2. **USB debugging:** Settings → System → Developer options → turn on **USB debugging**.
3. Plug the phone into the PC with a data-capable USB cable. On the phone, accept **Allow USB
   debugging?** and tick **Always allow from this computer**.
4. On the PC:
   ```powershell
   adb devices
   ```
   **Success:** one line with your phone's serial number and the word `device`. If it says
   `unauthorized`, unplug, plug back in, and accept the prompt on the phone.

---

## 4. Get the code

### First: put the Phase 0 code on `main`
**Done on 2026-10-08** (pull request #2). Phase 1 was built on the same branch and goes to `main`
the same way, with a new pull request ([section 16](#16-phase-1-the-core-loop-on-your-phone)).

Phase 0 was built on the branch `claude/bold-fermi-oglgch`. Until that branch is merged, `main` (the
branch a plain `git clone` gives you) has only the plan and none of the code, and the APK workflow in
[section 10](#10-optional-the-github-actions-apk) has no **Run workflow** button. Merge it with a pull
request on GitHub:

1. Open https://github.com/FabianB14/DualRep → **Pull requests** → **New pull request**.
2. Set **base** to `main` and **compare** to `claude/bold-fermi-oglgch`, then click **Create pull
   request**, give it a title, and click **Create pull request** again.
3. The checks run on the pull request (CI takes a few minutes; the Android APK build takes about 15).
   When they are green, click **Merge pull request** → **Confirm merge**.

Want to start before it is merged? Clone the branch itself: in the commands below, use
`git clone -b claude/bold-fermi-oglgch https://github.com/FabianB14/DualRep.git dualrep` instead of
the plain `git clone` line. Once the pull request is merged, switch that copy to `main` with
`git checkout main` and then `git pull`.

### Clone and check
```powershell
mkdir C:\dev
cd C:\dev
git clone https://github.com/FabianB14/DualRep.git dualrep
cd dualrep
npm ci
npm run check
```

- `npm ci` installs the exact package versions from `package-lock.json`. It takes a few minutes.
- `npm run check` runs the type check, the linter, the unit tests and the offline sync-config check.

**Success:** `npm run check` ends without errors.

### Optional: the database tests on your PC
`npm run db:test` (the database tests) needs Linux with Postgres 16, pgvector and pgTAP, so it runs in
GitHub Actions rather than on Windows. If you want it locally, use WSL with **Ubuntu 24.04** (the
same system CI uses), and clone the repo **again inside WSL's own filesystem**. Don't run it from the
Windows copy under `/mnt/c/dev/dualrep`. In the Ubuntu terminal, after installing Node 22 there (the
Linux instructions at https://nodejs.org/en/download):
```bash
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-16-pgvector postgresql-16-pgtap
git clone https://github.com/FabianB14/DualRep.git ~/dualrep   # add -b claude/bold-fermi-oglgch until it is merged
cd ~/dualrep
npm run db:test
```
It ends with `db-test: all 15 test files passed (626 tests)`.

**Line endings on Windows.** Git for Windows' default setting checks files out with Windows line
endings, which breaks shell scripts in Linux. The repo's `.gitattributes` keeps `.sh`, `.sql`, `.mjs`,
`.toml`, `.yml` and `.yaml` files on Unix line endings, but a Windows copy cloned before that file
existed keeps the old endings until the files are checked out again. To fix such a copy, commit or
save any changes you want to keep, then in `C:\dev\dualrep` run:
```powershell
git rm --cached -r -q .
git reset --hard
```
(Or delete the folder and clone again.)

---

## 5. Create the Supabase project and push the database

### Create the project
1. https://supabase.com/dashboard → **New project**.
2. Fill in:
   - **Name:** `dualrep-dev`
   - **Database password:** click **Generate a password**, then save it in your password manager as
     "DualRep Supabase DB". You need it in the next step.
   - **Region:** the one closest to you (for example East US). Remember it: the PowerSync instance
     should be in the same part of the world.
   - **Plan:** Free.
3. Wait a minute or two until the project is ready.
4. Find the **project ref**: the 20-letter id in the dashboard URL
   (`https://supabase.com/dashboard/project/<project-ref>`), also under Project Settings → General.
5. Check the Postgres version. Open **SQL Editor** and run `show server_version;`. It should start with
   **17**, matching `supabase/config.toml` (`major_version = 17`). If it doesn't, tell whoever
   maintains the repo (the config is only used for local tooling, so this isn't a blocker).

### Push the migration: two ways
The "migration" is one SQL file in the repo,
[`supabase/migrations/20261008000000_initial_schema.sql`](../supabase/migrations/20261008000000_initial_schema.sql).
It creates all of DualRep's tables, security rules and the six system presets in your project. Pick
one way to send it:

- **Option 1, in the browser (nothing to install).** Fine if you are testing with the GitHub APK
  (section 10) and haven't set up your PC yet.
- **Option 2, with the Supabase CLI** (below). Needs the code on your PC (section 4). This is how every
  later migration goes out, so you will switch to it eventually.

#### Option 1: paste it into the SQL Editor
1. On GitHub, open the file
   ([`supabase/migrations/20261008000000_initial_schema.sql`](../supabase/migrations/20261008000000_initial_schema.sql);
   until the Phase 0 pull request is merged, switch the branch picker at the top left to
   `claude/bold-fermi-oglgch`). Click the **Copy raw file** button (two overlapping squares, top right
   of the file).
2. In the Supabase dashboard: **SQL Editor** → **New query**. Paste (Ctrl+V) and click **Run**. It
   takes a few seconds and should end with "Success. No rows returned".
3. If it shows an error instead, don't run it again on top: take a screenshot of the message and get
   help first (a second run fails on the tables the first one already made).

Later, the first time you use the CLI on this project (Option 2), tell it this migration is already
in, so `db push` doesn't try to run it a second time:
```powershell
npx supabase migration repair 20261008000000 --status applied
```
If you have also pasted Phase 1's migration (section 16), name both:
`npx supabase migration repair 20261008000000 20261008120000 --status applied`.

#### Option 2: link the repo and push with the CLI
In `C:\dev\dualrep`:
```powershell
npx supabase login
npx supabase link --project-ref <project-ref>
```
- `login` opens a browser to approve the CLI.
- `link` asks for the **database password** from above.

Then apply the schema:
```powershell
npx supabase db push
```
It lists `20261008000000_initial_schema.sql` (and, from Phase 1 on,
`20261008120000_starter_library.sql`) and asks to confirm. Type `Y`.

**Success (either option):** no errors, and in the dashboard:
- **Table Editor** lists 23 tables (`profiles`, `entitlements`, `presets`, … `tracy_events`).
- **SQL Editor** → run these checks:
  ```sql
  select count(*) from pg_tables where schemaname = 'public';                     -- 23
  select count(*) from pg_publication_tables where pubname = 'powersync';         -- 22 (all but source_chunks)
  select name from public.presets where owner_id is null order by id;             -- the 6 system presets
  ```

`npx supabase migration list --linked` shows which migrations the hosted project has. **From Phase 2
on, migrations go out through the Deploy backend workflow on GitHub** (no PC tools, no database
password; [§17 step 5](#step-5-deploy-the-backend-a-dry-run-then-for-real)). `npx supabase db push`
still works if you prefer the command line.

### Copy the API settings for the app
Project Settings → **API Keys** (and **Data API** for the URL):
- **Project URL:** `https://<project-ref>.supabase.co` → `EXPO_PUBLIC_SUPABASE_URL`
- **Publishable key:** starts with `sb_publishable_` → `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  (on a project that only shows legacy keys, use the **anon** key).

**Never** put the `sb_secret_…` key or the `service_role` key in the app. They bypass all row
security. The app refuses to start with them and shows "Setup needed".

---

## 6. Set up sign-in emails and check the signing keys

DualRep signs you in with a **6-digit code** typed into the app. Supabase's default emails contain a
link instead, so change them. Supabase only lets you edit the templates once the project sends email
through **your own email service ("custom SMTP")**: until then the template page shows "Set up custom
SMTP to edit templates" and the subject and body can't be edited. You need custom SMTP before beta
testers join anyway (the built-in sender only emails your Supabase team, a few times an hour).

### Custom SMTP with Resend (free)
[Resend](https://resend.com) has a free plan (about 3,000 emails a month, 100 a day; **verify** at
resend.com/pricing). Without a domain of your own it runs in test mode: it sends only **from**
`onboarding@resend.dev` and only **to** the email address you signed up to Resend with (**verify**).
That's enough for the Phase 0 gate: sign up to Resend with the same address you'll sign in to DualRep
with.

1. Sign up at https://resend.com with the email address you'll use in DualRep.
2. Resend dashboard → **API Keys** → **Create API Key** → name `dualrep-supabase`, permission
   **Sending access** → **Add**. Copy the key (starts with `re_`); it is shown once. Save it in your
   password manager.
3. Supabase dashboard → **Authentication → Emails → SMTP Settings** (or the **Set up SMTP** button on
   the template page) → turn on **Enable custom SMTP** and fill in:

   | Field | Value |
   |---|---|
   | Sender email | `onboarding@resend.dev` |
   | Sender name | `DualRep` |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | the `re_…` API key |

   Leave the minimum interval as it is and **Save**.
4. Later, before testers join: buy a domain (for example `dualrep.app`), verify it in Resend
   (**Domains → Add domain**, then add the DNS records it shows), and change the sender email to
   something like `no-reply@dualrep.app`. Then Resend can email anyone.

**Success:** the template page no longer shows "Set up custom SMTP to edit templates", and the
subject and body can be edited.

### Email templates
In the dashboard: **Authentication → Emails → Templates**. For each template, switch the **Body** to
**Source**, select everything in it (Ctrl+A), delete it, and paste the new one. The easiest way to
copy a file is to open its "raw" link and press Ctrl+A, Ctrl+C:
`https://raw.githubusercontent.com/FabianB14/DualRep/main/supabase/templates/magic_link.html` and
`.../confirmation.html` (until the Phase 0 pull request is merged, replace `main` with
`claude/bold-fermi-oglgch` in the link).

1. **Magic link** template (sent to existing users):
   - Subject: `Your DualRep sign-in code`
   - Body: paste the whole of [`supabase/templates/magic_link.html`](../supabase/templates/magic_link.html)
2. **Confirm signup** template (sent to new users):
   - Subject: `Your DualRep sign-in code`
   - Body: paste the whole of [`supabase/templates/confirmation.html`](../supabase/templates/confirmation.html)
3. Save each one.

The important part of each template is `{{ .Token }}`, the sign-in code. If an email ever arrives with
a link but no code, that template wasn't saved.

### Email sign-in settings
**Authentication → Sign In / Providers → Email** (**verify** the menu names):

- **Email provider:** enabled.
- **Email OTP length:** **6** (easiest to type). The app accepts any length Supabase allows (6 to 10),
  but older builds of the app only took 6 digits: if the email has 8 digits and the app won't take
  them, set this to 6 and send a new code.
- **Email OTP expiration:** `3600` seconds (1 hour), matching `supabase/config.toml` and the email
  text.
- **Confirm email:** leave it **on** (Supabase's default, and what `supabase/config.toml` uses
  locally). Signing in with the code confirms the address in the same step, so the app works the
  same; with it off, anyone could pre-register someone else's address with a password through the
  public API.

### JWT signing keys
**Project Settings → JWT Keys** (**verify** the name). The **current** key should be an asymmetric key
(type ECC P-256 or RSA). New Supabase projects use asymmetric keys by default.

- **Asymmetric:** nothing to do. PowerSync fetches the public keys from your project automatically.
- **Only a "Legacy JWT secret" (HS256) is current:** either migrate to signing keys in that screen
  (recommended), or later paste the legacy secret into PowerSync's "Supabase JWT Secret" field.

**Success:** you know which kind of key the project uses.

---

## 7. Create the PowerSync database role

PowerSync reads changes from Postgres through **logical replication**, using its own login. The
migration can't create it because it needs a password, so you create it once by hand.

1. Create a password: in your password manager, generate **32+ characters, letters and digits only**
   (symbols such as `@ : / ?` break connection strings). Save it as "DualRep PowerSync role".
2. In the Supabase **SQL Editor**, paste this, put the password between the quotes, and run it:
   ```sql
   -- PowerSync replication login (from PowerSync's Supabase guide).
   -- replication: may read the change stream. bypassrls: must see every row to sync it.
   create role powersync_role with replication bypassrls login password 'PASTE-THE-PASSWORD-HERE';

   -- Read access to the app tables, now and in future migrations.
   grant usage on schema public to powersync_role;
   grant select on all tables in schema public to powersync_role;
   alter default privileges in schema public grant select on tables to powersync_role;
   ```
3. Clear the editor afterwards, and if the SQL Editor kept the query in its snippets list, delete that
   snippet. The password should live only in your password manager and in PowerSync.
4. Check:
   ```sql
   select rolname, rolreplication, rolbypassrls from pg_roles where rolname = 'powersync_role';
   -- powersync_role | true | true
   ```

The `powersync` publication (which tables stream to PowerSync) is already created by the migration.
Changed your mind about the password later? `alter role powersync_role password '...';` and update
PowerSync.

---

## 8. Create the PowerSync instance

Use **either** the dashboard (8A, simplest) **or** the command line (8B, config as code). Both end in
the same place.

### 8A. With the dashboard
1. https://dashboard.powersync.com → create a **project** (for example `DualRep`), then a new
   **instance** named `dualrep-dev`.
2. **Region:** the same part of the world as your Supabase project. It can't be changed later.
3. **Database connection** (Postgres):
   - **Host:** `db.<project-ref>.supabase.co` (the **direct** connection, not the pooler
     `…pooler.supabase.com`). Logical replication doesn't work through the pooler, and PowerSync uses
     this host name to find your project's sign-in keys.
   - **Port:** `5432` · **Database:** `postgres` · **Username:** `powersync_role` · **Password:** the
     role password from section 7.
   - **SSL mode:** `verify-full`.
   - Or paste the URI form: `postgresql://powersync_role:<password>@db.<project-ref>.supabase.co:5432/postgres`.
   - Click **Test connection**.
4. **Client auth:** tick **Use Supabase Auth**. Leave the legacy "Supabase JWT Secret" empty if section
   6 showed asymmetric keys. Optionally tick **Development tokens** (useful for debugging; dev
   instance only).
5. **Save and deploy.**
6. **Sync config:** open the instance's sync config editor (**verify** the tab name: "Sync Streams" or
   "Sync Config"), replace its contents with the whole of
   [`powersync/sync-config.yaml`](../powersync/sync-config.yaml), validate, and deploy.
7. Copy the **instance URL** (it looks like `https://<id>.powersync.journeyapps.com`) for
   `EXPO_PUBLIC_POWERSYNC_URL`. No slash at the end.

**About IPv6:** Supabase's direct host (`db.<ref>.supabase.co`) is reachable over IPv6. Whether
PowerSync Cloud connects to it over IPv6 was not confirmed during research. If **Test connection**
fails with a network or timeout error (not a password error), the fix is Supabase's IPv4 add-on
(about $4/month on a paid Supabase plan: **verify**).

### 8B. With the PowerSync CLI (config as code)
The repo already has the instance config ([`powersync/service.yaml`](../powersync/service.yaml)) and the
sync config. Check `region:` in `service.yaml` first (it says `us`; change it to `eu` before the first
deploy if your Supabase project is in Europe).

```powershell
# Only for this PowerShell window: the CLI reads these through `!env` in service.yaml.
$env:POWERSYNC_DATABASE_URI = "postgresql://powersync_role@db.<project-ref>.supabase.co:5432/postgres"
$env:POWERSYNC_DATABASE_PASSWORD = "<the role password>"

npx powersync login                                        # opens the dashboard to create a token
npx powersync link cloud --create --project-id=<PowerSync project id>
npm run validate:sync                                      # offline check against the schema
npx powersync validate                                     # checks the live connection too
npx powersync deploy
```
- The PowerSync **project id** is in the dashboard URL of your PowerSync project.
- `link` writes `powersync/cli.yaml`. Don't commit it; it only links your copy to your instance.
- Created the instance in the dashboard already? Link to it with
  `npx powersync link cloud --instance-id=<instance id>`, then `npx powersync deploy sync-config`
  deploys just the sync config.
- After the first deploy you can switch the password in `service.yaml` to
  `secret_ref: default_password` so it never has to be supplied again (see the comment in the file).

### Check that replication runs
- `npx powersync status` (8B) or the instance's status page (8A) shows the connection healthy and
  replication active.
- In the Supabase SQL Editor:
  ```sql
  select slot_name, active, wal_status from pg_replication_slots;   -- one row, active = true
  ```

### Keep the free instance alive
A free PowerSync instance is **removed after 7 days with no deploys and no app connections**. Open the
app (signed in, online) at least once a week, or redeploy. If it is removed, recreate it (8A or 8B) and
drop its old replication slot ([Troubleshooting](#15-troubleshooting)).

---

## 9. Build the app and put it on your phone

DualRep can't run in Expo Go (its database is native code), so you install **your own build** of the
app. There are three ways. They all end with an app on your phone.

| Path | Needs on your PC | Cost | Good for |
|---|---|---|---|
| **A. EAS cloud build** | Node + `eas-cli` | Free plan (limited builds per month, queued) | No Android Studio; easy install link |
| **B. Local build** (`npm run android`) | Everything in section 2 | Free | Fast repeat builds once set up; works offline |
| **C. GitHub Actions APK** ([section 10](#10-optional-the-github-actions-apk)) | Nothing | Free (Actions minutes) | A standalone **preview** APK to test release behaviour |

The app comes in three **variants**, so they can sit side by side on one phone:

| Variant | App name | Package | Loads its JavaScript from |
|---|---|---|---|
| development | DualRep (dev) | `com.interverse.dualrep.dev` | Metro on your PC (`npm start`), so code changes appear instantly |
| preview | DualRep (preview) | `com.interverse.dualrep.preview` | Inside the APK (release build, HTTPS only) |
| production | DualRep | `com.interverse.dualrep` | Inside the app bundle (Play Store) |

For Phase 0 you want a **development** build first, then one **preview** build for the final check.

### Fill in `.env` (every path)
In `C:\dev\dualrep`:
```powershell
Copy-Item .env.example .env
notepad .env
```
Fill in the three public values from sections 5 and 8, and leave `APP_VARIANT=development`:
```ini
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
EXPO_PUBLIC_POWERSYNC_URL=https://<instance-id>.powersync.journeyapps.com
APP_VARIANT=development
```
`.env` is in `.gitignore`; it never gets committed. These three values are public by design (anyone
with the APK can read them). Secrets never go in this file.

Who reads `.env`: `npm start` and `npm run android` (the Expo CLI loads it). **EAS commands and EAS
cloud builds don't**, so path A stores the values in EAS as well.

### Path A: EAS cloud build (no Android Studio needed)
1. Log in and create the EAS project:
   ```powershell
   eas login
   eas init
   ```
   `eas init` creates the project on expo.dev and prints its **project id**. It then warns that it
   can't write the id into `app.config.ts` (the config is code, so the id comes from an environment
   variable instead). That warning is expected. You can also find the id on the project's page at
   expo.dev.
2. Make the id available to every `eas` command on this PC, then **open a new PowerShell window**:
   ```powershell
   [Environment]::SetEnvironmentVariable('EAS_PROJECT_ID', '<project id>', 'User')
   ```
   Also put it in `.env` (`EAS_PROJECT_ID=<project id>`) so the Expo CLI sees the same value.
3. Store the values the cloud build needs (EAS environments `development`, `preview`, `production`
   match the build profiles in `eas.json`):
   ```powershell
   eas env:set --name EAS_PROJECT_ID --value <project id> --environment development --environment preview --environment production --visibility plaintext
   eas env:set --name EXPO_PUBLIC_SUPABASE_URL --value https://<project-ref>.supabase.co --environment development --environment preview --visibility plaintext
   eas env:set --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value <sb_publishable_...> --environment development --environment preview --visibility plaintext
   eas env:set --name EXPO_PUBLIC_POWERSYNC_URL --value https://<instance-id>.powersync.journeyapps.com --environment development --environment preview --visibility plaintext
   ```
   `eas env:list --environment preview` shows what is stored. (A development build loads its
   JavaScript from your PC, so it uses your local `.env`; a preview build carries its JavaScript
   inside and uses these stored values.) The `production` environment gets its own values in Phase
   5 ([ANDROID.md 5.2](ANDROID.md#52-signing-and-eas-submit)), so a production build never points at
   this development backend.
4. Start the build:
   ```powershell
   eas build -p android --profile development
   ```
   The first time, it offers to **generate a new Android keystore**: answer **yes** (EAS stores it for
   you). The build runs in the cloud; free-plan builds can wait in a queue before they start. The
   terminal shows a link to follow the build.
5. **Install:** when the build finishes, open the build page on your phone (scan the QR code shown in
   the terminal or on expo.dev), download the APK and open it. Allow your browser to **install unknown
   apps** when Android asks.

**Success:** "DualRep (dev)" is on your phone. For the preview build later:
`eas build -p android --profile preview`.

### Path B: build on your PC
Needs everything in section 2 and the phone plugged in (`adb devices` shows it).
```powershell
cd C:\dev\dualrep
npm run android
```
- This runs `expo run:android`: it generates the native project (`android/`, gitignored), compiles it
  with Gradle, installs **DualRep (dev)** on the phone, starts Metro and opens the app.
- The **first** build downloads Gradle and its dependencies and compiles all the native code, so it
  is slow (often 15 minutes or more). Later builds are much faster. You only rebuild when native
  code or `app.config.ts` changes; JavaScript changes just reload.
- If it fails, see [local build errors](#local-build-errors-on-windows).

**Success:** the app opens on the phone. Skip to [section 11](#11-start-the-app-and-sign-in).

---

## 10. Optional: the GitHub Actions APK

The workflow [`.github/workflows/android.yml`](../.github/workflows/android.yml) builds an installable
**arm64** APK on GitHub's machines, with no EAS account and no Android Studio. It also runs the 16 KB
page-size check ([`scripts/check-16kb.sh`](../scripts/check-16kb.sh): zip and ELF alignment of every
native library; the run fails if either is off, see [ANDROID.md 0.7](ANDROID.md#07-16-kb-page-size-check))
and lists the APK's permissions on the run's summary page. (It runs by itself on pull requests, and
on pushes to `claude/` branches, that change `package.json`, `package-lock.json`, `app.config.ts`,
`eas.json` or the workflow, to prove the native code still compiles.)

1. **Give it the app settings.** On GitHub: the repo → **Settings → Secrets and variables → Actions →
   Variables** tab → **New repository variable**, three times:

   | Name | Value |
   |---|---|
   | `EXPO_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key |
   | `EXPO_PUBLIC_POWERSYNC_URL` | the PowerSync instance URL |

   These are **variables**, not secrets: the values ship inside the app anyway. No secrets are
   needed. Without them the APK opens on "Setup needed".
2. **Run it:** **Actions → Android APK → Run workflow**. In the box that opens, **Use workflow from**
   picks the branch to build (`main`, or a branch whose pull request isn't merged yet), and the
   second field picks the variant. (GitHub shows the **Run workflow** button only once `android.yml`
   is on the default branch, `main`; it has been there since 2026-10-08.)
   - `preview`: the JavaScript is inside the APK, so it runs on its own. Use this for the final gate
     check.
   - `development`: a dev client that needs Metro (`npm start`) on your PC.
3. Wait for the green check (a first run can take a while), open the run, and download the artifact
   **`dualrep-preview-arm64-apk`** (or `-development-`) at the bottom. It is a zip with the APK
   inside; artifacts are kept for 14 days. Unzip it (right-click → Extract All).
4. **Install** with the phone plugged in:
   ```powershell
   adb install -r "<the unzipped folder>\app-release.apk"   # preview; a development build is app-debug.apk
   ```
   Or copy the APK to the phone and open it.

The APK is signed with the Expo template's **debug key**: fine for your own phones, never for the
Play Store (use EAS for store builds). Android won't install it over an EAS build of the same variant,
because the signing keys differ: uninstall the other one first.

---

## 11. Start the app and sign in

### Development build: connect it to Metro
A development build loads its JavaScript from Metro on your PC. (Path B already started Metro and
opened the app; skip to "Sign in".)

1. In `C:\dev\dualrep`:
   ```powershell
   npm start
   ```
   Leave this window open. It prints a QR code and `Metro waiting on …`.
2. With the phone on **USB**, let it reach Metro through the cable:
   ```powershell
   adb reverse tcp:8081 tcp:8081
   ```
   (On the same **Wi-Fi** instead, skip this; the phone finds the PC on the network. The "hard case"
   in section 12 needs USB, though.)
3. Open **DualRep (dev)** on the phone. Its launcher lists the development server running on your PC:
   tap it. If the list is empty, enter the address by hand: `http://localhost:8081` over USB (after
   `adb reverse`), or `http://<your PC's IP>:8081` over Wi-Fi.

A **preview** build needs none of this; just open it.

### Sign in
1. If you see **Setup needed**, a value in `.env` (or in EAS, or the GitHub variables) is missing or
   wrong; the screen says which. Fix it, then restart Metro with `npm start -- --clear`.
2. **Sign in** screen: type your email address (the one from section 1) and tap **Send code**.
3. The email "Your DualRep sign-in code" arrives with a 6-digit code (or longer, if the project's
   OTP length is set higher). It can take a few minutes:
   check spam before you tap **Send a new code**. Supabase's built-in sender only sends a few emails
   per hour for the whole project, and every resend uses one up.
4. **Check your email** screen: type the code and tap **Sign in**.
5. The app opens on **Today** (the home screen). Scroll down to **More** and open **Settings**: it
   says "Signed in as <your email>". On its **Sync** card, wait until **Connected** says **Yes** and
   the status says **Up to date**. The first sync downloads the system presets (and, once the Phase 1
   migration is in, the starter exercises).

**Success:** signed in, Sync card connected. If it stays "Connecting" or "Offline" while the phone is
online, see [PowerSync won't connect](#powersync-wont-connect-the-sync-card-stays-connecting-or-offline-while-online).

---

## 12. Run the Sync Check (the Phase 0 gate)

The Sync Check screen walks you through the gate one step at a time. It writes a test row into
`study_sessions` (its subject starts with `Sync check `) while the phone is offline, and at the end
asks Supabase directly, not through PowerSync, whether the row is in Postgres. It is strict, so a
PASS really means "saved offline, synced later":

- it creates the test row only after checking that the phone **can't reach the server** at that
  moment (Android can keep Wi-Fi on in airplane mode), and
- PASS also needs the **PowerSync sync stream to be connected** at the end. The upload goes through
  Supabase, so a row in Postgres alone doesn't prove that sync works.

On the home screen (**Today**), scroll down to **More** and tap **Sync check**. Then:

1. **Turn on airplane mode.** Open quick settings and turn on airplane mode; turn Wi-Fi off too if it
   stays on. The pill under the instructions shows PowerSync's connection: right after switching it
   says **Sync server still connected — wait a few seconds after switching**. When it says **Sync
   server not connected**, tap **Airplane mode is on**.
2. **Create a test row.** Tap **Create test row**. The app first checks that it can't reach the
   server, then saves the row on the phone only. The **Test row** card shows the row's id and
   **Stored on this phone**. Note the first few characters of the id (or take a screenshot).
3. **Turn airplane mode off** (and Wi-Fi back on). Stay on this screen. Tap **Airplane mode is off**.
   The pill says **Waiting for the sync server…**, then **Sync server connected**.
4. **Wait for the upload.** The button shows **Waiting to upload: 1** and moves on by itself when it
   reaches 0, usually within seconds of the sync server connecting.
5. **Check Postgres.** Tap **Check Postgres**.

**Success:** a green **PASS** card: "The row made offline is in Postgres." Take a screenshot for your
records, then confirm it from the server side in [section 13](#13-confirm-the-row-in-postgres).

If it doesn't pass:

| The screen says | What to do |
|---|---|
| "The phone can still reach the server, so this would not test offline saving…" (step 2) | The phone is still online, usually because Wi-Fi stayed on. Turn on airplane mode, turn Wi-Fi off, then tap **Create test row** again. |
| "Not in Postgres yet" | Look for an **Upload problems** card on the same screen and read its code in [Troubleshooting](#the-row-never-reaches-postgres). If there is none and "Waiting to upload" isn't 0, the phone isn't connected yet. |
| "The row reached Postgres, but the PowerSync stream is not connected…" | Uploads work, but the phone isn't receiving from PowerSync, so the gate isn't met yet. Check `EXPO_PUBLIC_POWERSYNC_URL` and PowerSync's **Use Supabase Auth** setting (section 8), and see [PowerSync won't connect](#powersync-wont-connect-the-sync-card-stays-connecting-or-offline-while-online). When the Sync card says **Connected: Yes**, tap **Check Postgres again**. |
| "No connection" | Airplane mode or Wi-Fi is still off. |
| "The server could not be asked" | The Supabase URL or key in the build is wrong. |
| "Waiting to upload" stays above 0 | The phone isn't sending yet. If the Sync card's **Connected** says **No**, see [PowerSync won't connect](#powersync-wont-connect-the-sync-card-stays-connecting-or-offline-while-online): the queued row is sent once the sync server connects. Also read **Last error** on the Sync card ([Troubleshooting](#the-row-never-reaches-postgres), step 3). |

### The hard case (recommended once)
This proves a queued write survives the app being closed. Run it on the **preview** build (its
JavaScript is inside the APK), or on the development build only with the phone on **USB** after
`adb reverse tcp:8081 tcp:8081` ([section 11](#11-start-the-app-and-sign-in)); USB keeps working in
airplane mode. A development build that reaches Metro over Wi-Fi can't load its JavaScript when you
reopen it offline.
1. Turn airplane mode on and create a test row (steps 1–2).
2. **Swipe DualRep away** from the recent-apps screen. Don't use "Force stop" in Settings.
3. Still in airplane mode, open DualRep again and open **Sync check** (under **More** on Today).
   (On a development build the launcher may open first: tap the development server, or enter
   `http://localhost:8081`.) The steps start over, which is fine: the **Test rows on this phone**
   list still shows your row, and the Sync card shows **Waiting to upload: 1**.
4. Turn airplane mode off. Watch **Waiting to upload** drop to 0, then confirm the row in Postgres
   ([section 13](#13-confirm-the-row-in-postgres)) using the id from the list.

If you are curious what the phone logs while this happens: `adb logcat -s ReactNativeJS`.

---

## 13. Confirm the row in Postgres

1. Supabase dashboard → **Table Editor** → `study_sessions`. Sort by `created_at`, newest first.
2. Find the row whose `focus_subject` starts with `Sync check ` and whose `id` matches the id on the
   phone.
3. Or in the **SQL Editor**:
   ```sql
   select id, user_id, focus_subject, created_at
   from public.study_sessions
   where focus_subject like 'Sync check %'
   order by created_at desc;
   ```
   The `user_id` is yours: `select id, email from auth.users;` shows it.

**Success:** the row is there. **The Phase 0 gate has passed.** Tick it in [ROADMAP.md](ROADMAP.md).

Then do it once more with a **preview** (release) build, which proves that release networking (HTTPS
only, no Metro) works too. Signing in on the preview build needs another sign-in email: if you've
already asked for two or three codes this hour, wait an hour first (see
[the sign-in email doesn't arrive](#the-sign-in-email-doesnt-arrive)).

Clean up probe rows whenever you like (the deletes sync back to the phone):
```sql
delete from public.study_sessions where focus_subject like 'Sync check %';
```

---

## 14. Give yourself beta access for testing

Beta testers get the full subscription feature set for free until the beta ends. That is an
`entitlements` row with `tier = 'subscription'` and `source = 'beta'`. Only the server can write that
table, so you set it in the **SQL Editor** (which runs with full rights).

Give an account beta access until a date:
```sql
update public.entitlements
set tier = 'subscription', source = 'beta', expires_at = '2026-12-31T23:59:59Z'
where user_id = (select id from auth.users where email = 'you@example.com');
```

Every account gets a free `entitlements` row when it is created. If the update says `UPDATE 0`, the
account doesn't exist yet: sign in on the phone first.

Check it:
```sql
select u.email, e.tier, e.source, e.expires_at, public.has_paid_access(u.id) as paid
from auth.users u join public.entitlements e on e.user_id = u.id;
```
`paid` is `true` for an active subscription or beta entitlement. The change syncs to the phone.

What it unlocks today: **creating groups** (free accounts can join a group but not create one). To test
groups you need a second account with a second email address. Until custom email sending is set up,
that address must also be a member of your Supabase team (Organization settings → Team → invite it;
**verify**), or the code email won't be delivered.

Take it away again:
```sql
update public.entitlements
set tier = 'free', source = 'none', expires_at = null
where user_id = (select id from auth.users where email = 'you@example.com');
```

---

## 15. Troubleshooting

### The row never reaches Postgres
1. Open the Sync Check screen and look at **upload problems** (the local `upload_failures` log). The
   app writes a failed upload there, with its error code, when the server refused it for good.
2. Read the code:

   | Code | Meaning | Fix |
   |---|---|---|
   | **42501** | Permission denied for a signed-in user (the server answered HTTP 403): a missing **grant** or a missing/failed **RLS policy** | Check the migration is on the hosted project (`npx supabase migration list --linked`), and that you are signed in as the row's owner. A table created by hand without grants does this too. |
   | 23503 | A required parent row doesn't exist (foreign key) | The parent row (for example the study session of a focus block) never reached the server. Fix that one first. |
   | 23505 | Duplicate (unique constraint) | Usually harmless: the same row was uploaded twice. |
   | 22P02 or another 22xxx | Bad data (a value Postgres can't read) | A bug in the app's write code: send the error message to whoever maintains the code. |
   | `DUALREP_…` | The app refused to send a write the server would reject anyway (for example to a read-only table) | A bug in the app's write code. |

   What never shows up here: a request the server answered with **HTTP 401** (not signed in, or an
   expired sign-in). Those are retried, never dropped. Optional links that the server can't keep (a
   set's exercise or a session's plan that someone else unshared or deleted) don't fail either: the
   server stores them as empty and the write goes through
   ([DATA_MODEL.md](DATA_MODEL.md#writes-the-server-normalizes-instead-of-refusing)).

3. **"Waiting to upload" never reaches 0, no upload problem:** the phone isn't sending yet. Look at
   **Connected** and **Last error** on the Sync card:
   - **Connected: No** — the phone isn't connected to PowerSync; see the PowerSync errors below. A
     queued write is sent once it connects.
   - **Last error: "No signed-in Supabase session; the upload waits until the user signs in
     again"** — the sign-in was lost (for example it was revoked). Nothing is sent and nothing is
     lost: sign in again with the **same** email and the queue uploads. (Signing in with a different
     email clears the phone's data first, unsent writes included.)
4. Watch the phone's logs while it happens:
   ```powershell
   adb logcat -s ReactNativeJS
   ```
   Every discarded upload is logged as `[sync] upload of … discarded`.

### PowerSync won't connect (the Sync card stays "Connecting" or "Offline" while online)
- **Check the URL:** `EXPO_PUBLIC_POWERSYNC_URL` is the instance URL from the dashboard, with no slash
  at the end. After changing `.env`, restart Metro with `npm start -- --clear` (or rebuild a preview
  APK).
- **Token errors** (in the PowerSync dashboard logs, or `adb logcat`):

  | Message | Fix |
  |---|---|
  | "Token is a Supabase Legacy HS256 token, but Supabase JWT secret is not configured" | Your project signs with the legacy secret. Migrate to asymmetric signing keys (section 6), or paste the legacy secret into PowerSync's client auth settings. |
  | "Supabase project id mismatch" | The PowerSync connection points at a different Supabase project than the app's `EXPO_PUBLIC_SUPABASE_URL`. |
  | "Supabase Auth is enabled, but no Supabase connection string found" | The connection host isn't `db.<project-ref>.supabase.co` (for example, it is the pooler). Use the direct host. |

- **Replication errors** (PowerSync instance status):

  | Message | Fix |
  |---|---|
  | `Publication 'powersync' does not exist` | The migration isn't on the project yet: `npx supabase db push`. |
  | `PSYNC_S1145` … `BYPASSRLS` | Run `alter role powersync_role bypassrls;` in the SQL Editor. |
  | Password authentication failed | Wrong role password in PowerSync. Reset it with `alter role powersync_role password '...';` and update PowerSync. |
  | Timeout or network unreachable | The direct host is IPv6 (section 8A, "About IPv6"). |

### The free PowerSync instance disappeared
Free instances are removed after 7 days with no deploys and no app connections. Recreate it
(section 8). The old instance's **replication slot** may still be on Supabase, and an abandoned slot
makes Postgres keep old change logs, which uses up disk. Find and drop it:
```sql
select slot_name, active, wal_status from pg_replication_slots;
-- Only for a slot with active = false that belonged to the deleted instance:
select pg_drop_replication_slot('<slot_name>');
```

### The sign-in email doesn't arrive
- Check spam. Wait a few minutes: Supabase's built-in sender is slow and rate-limited.
- **"This server can’t send email to that address yet":** the built-in sender only sends to members of
  your Supabase team. Use your own address, or invite the other address to your team, or set up a
  custom email sender (SMTP) under Authentication settings (needed before beta testers join).
- **Custom SMTP with Resend in test mode** (section 6) delivers only to the address your Resend
  account uses. Sign in to DualRep with that address, or verify a domain in Resend.
- **"Too many emails sent…":** the app shows this for two different email limits.
  One allows one email per address per minute: waiting a minute fixes it. The other is for the whole
  project: Supabase's built-in sender sends only a few emails **per hour** (2–3 according to search
  results; **verify** under Authentication → Rate Limits). If waiting a minute doesn't help, wait up
  to an hour, or set up a custom email sender (SMTP), which lets you raise the limit.
  (**"Too many tries. Wait a minute, then try again."** is the general request limit: just wait.)
- The email has a **link but no code:** the templates are still Supabase's defaults. Set up custom
  SMTP, then paste and save both templates (section 6).

### "Setup needed" on the phone
The build is missing an `EXPO_PUBLIC_…` value, or one is wrong (the screen says which). For a
development build, fix `.env` and restart Metro with `npm start -- --clear`. For an EAS build, update the EAS
environment variables and build again. For the GitHub APK, fix the repository variables and rerun the
workflow.

### The app can't reach Metro ("Unable to load script" / "Could not connect to development server")
- Phone on USB: run `adb reverse tcp:8081 tcp:8081`, then reload the app.
- Phone on Wi-Fi: the phone and PC must be on the same network, and Windows Firewall must allow Node.js
  on private networks (Windows asks the first time Metro runs; if you clicked Cancel, allow
  "Node.js JavaScript Runtime" in Windows Security → Firewall → Allow an app).
- Metro must be running: `npm start` in `C:\dev\dualrep`.

### Local build errors on Windows
| Error | Fix |
|---|---|
| `Filename longer than 260 characters`, or CMake/Ninja errors about long object paths | Section 2, steps 2 and 6: long paths on, repo at `C:\dev\dualrep`. Then regenerate the native project with `npm run prebuild:android` (it deletes and recreates `android/`) and build again with `npm run android`. |
| `Cannot find a Java installation … languageVersion=17` | Install JDK 17 and set `JAVA_HOME` (section 2, step 3). Open a new terminal. |
| `SDK location not found` | `ANDROID_HOME` isn't set in this terminal (section 2, step 5). Open a new terminal. |
| `NDK … did not have a source.properties file` or a missing NDK/CMake | Install NDK 27.1.12297006 and CMake 3.30.5 in the SDK Manager (section 2, step 4). |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An app with the same package name but a different signing key is installed (for example an EAS build vs the GitHub APK). Uninstall it from the phone first. |

### Signing out loses unsent changes
Signing out (Settings → **Sign out**) deletes the phone's copy of the data, **including writes that
haven't uploaded yet**. The app warns you when that would happen. Get online and let "Waiting to
upload" reach 0 first. It also finishes a running cycle or workout first (its end is sent to the
server if the phone is online) and withdraws its alerts.

---

## 16. Phase 1: the core loop on your phone

Phase 1 is the study → move → study loop: a focus block with a timer, a short workout that appears
by itself when the timer ends, and the next focus block after it. This section gets it onto your
phone and runs its gate:

> **A full study, lift, study cycle works in airplane mode, once with a home setup and once with a
> gym setup.**

You need the Phase 0 setup working (the hosted Supabase project, PowerSync, the phone signed in).
Everything here is free. Plan on about two hours: two short cycles and a 25-minute timer check.

Do the steps in order. **Step 1 must come before the gate runs.**

### Step 1: Add the starter library to the database
A migration is a SQL file that changes the database. Phase 1 has one new migration,
[`supabase/migrations/20261008120000_starter_library.sql`](../supabase/migrations/20261008120000_starter_library.sql).
It adds no tables. It adds 90 exercises written by Interverse, the "starter library".

The app already carries the same 90 exercises, so it works without this step. But the server needs
them too: when a logged set uploads, the server checks that its exercise exists. If it doesn't yet,
the set is still saved, but its link to the exercise is stored as empty (the name is kept), and that
can't be fixed later. So apply this first.

The whole file is about 640 lines, more than the SQL Editor takes in one paste (it stopped at about
150 lines). So the same SQL is also split into **7 parts** of under 120 lines each, in the folder
[`supabase/sql-editor/starter-library/`](../supabase/sql-editor/starter-library/). Each part is complete
on its own; together they do exactly what the full file does.

1. On GitHub, open the folder
   [`supabase/sql-editor/starter-library/`](../supabase/sql-editor/starter-library/). Until the Phase 1
   pull request is merged, switch the branch picker at the top left to `claude/bold-fermi-oglgch`.
2. Click `part-1-of-7.sql`, then **Copy raw file** (two overlapping squares, top right of the file).
3. In the Supabase dashboard, open your project, then **SQL Editor** (left sidebar) → **New query**.
   Paste (Ctrl+V) and click **Run**. It says "Success. No rows returned".
4. Do the same for parts 2 to 7: copy the part, then in the SQL Editor select everything in the editor
   (Ctrl+A), paste over it and click **Run**. The order doesn't matter, and running a part twice is
   harmless.
5. Check it. Replace the editor's text with this and click **Run**:
   ```sql
   select count(*) from public.exercises where origin = 'interverse' and reviewed;   -- 90
   ```
   If it shows less than 90, one part was missed: run all 7 again.

Unlike the first migration, running these twice is harmless: they rewrite the same 90 rows. If a
part shows an error, take a screenshot of the message and get help.

**PowerSync: nothing to do.** The sync config already sends every reviewed library exercise to every
phone, so the 90 rows reach the phone by themselves at the next sync. No redeploy.

**Supabase CLI, later:** the first time you use the CLI on this project
([section 5, Option 2](#option-2-link-the-repo-and-push-with-the-cli)), tell it both migrations are
already in, so `db push` doesn't run them again:
```powershell
npx supabase migration repair 20261008000000 20261008120000 --status applied
```

### Step 2: Build and install the Phase 1 app
1. On GitHub: **Actions → Android APK → Run workflow**. Under **Use workflow from**, pick the branch
   `claude/bold-fermi-oglgch` (once the Phase 1 pull request is merged, pick `main`). Leave the
   variant on `preview`. Click **Run workflow**. It takes 10–15 minutes.
   (A push to that branch that changes `package.json` also starts a build by itself. A green run of
   that is just as good.)
2. When it has a green check, open the run and download **`dualrep-preview-arm64-apk`** at the
   bottom. Unzip it (right-click → Extract All).
3. Install it **over** the old DualRep preview app. Either:
   - copy `app-release.apk` to the phone (USB cable, or Google Drive) and open it there. Android asks
     whether to update the app: tap **Update**; or
   - with the phone plugged in: `adb install -r "<the unzipped folder>\app-release.apk"`.

   You stay signed in, and the phone keeps its data. If Android says the app isn't installed, a
   build with a different signing key is on the phone: see `INSTALL_FAILED_UPDATE_INCOMPATIBLE` in
   [Troubleshooting](#local-build-errors-on-windows).
4. Open DualRep **while online**. It opens on **Today**. Scroll down to **More** → **Settings**. On
   the **Sync** card, wait for **Connected: Yes** and **Waiting to upload: 0**. That sync also
   brings down the 90 starter exercises.

**Success:** Today shows **Start a study block** and **Just train**.

### Step 3: The gate, run 1, with a home setup
This takes about 25 minutes. You don't have to train hard: tapping **Done** for each set is enough to
prove the loop. Keep the phone in airplane mode for the whole run.

1. **Go offline.** Turn on airplane mode, and turn Wi-Fi off too if it stays on. In Settings →
   **Sync**, wait until **Connected** says **No**.
2. **Start.** Go back to Today and tap **Start a study block**. On the start screen:
   - **What are you studying?** is optional.
   - **Focus block:** tap − until it says **10 min** (the shortest).
   - **Where are you training?** If you have no setup yet, tap **Home, just my body**. If you already
     have one, tap the **Setup** chip and pick a home setup.
   - **Workout length:** leave it on **10 min**.
   - Tap **Start focus block**. The first time, Android asks whether DualRep may send notifications.
     Tap **Allow**. (If you tap no, the timer still works; the phone just won't ring when the block
     ends.)
3. **Focus.** The ring shows the time left, with a line under it like "Next: 10-min home circuit ·
   Chair squat first". Lock the phone and put it down. Airplane mode doesn't stop the alert: it is
   scheduled on the phone itself.
4. **The handoff.** After 10 minutes the phone rings. Unlock it and tap the alert: DualRep opens on
   the first exercise. (If you keep the app open instead, the ring turns into the exercise card by
   itself when the time is up, with a short buzz. No tap needed.)
5. **The workout.** The screen stays on. For each set:
   - The card shows the exercise and its target, for example "10 reps" or "40 s".
   - Tap **Done**. A rest countdown follows; **Skip rest** moves on.
   - At least once, tap − two or three times before **Done** (a missed set). The spotter's note
     appears: an easier next set, or more rest.
   - Try **Swap** once and pick another exercise.
   - Optional: the effort chips (Easy, Solid, All out), and "How was that focus block?" (1–5).
6. **Back to studying.** When the circuit ends, the screen says "Next focus block in 0:30". Don't tap
   anything. After 30 seconds the next focus block starts by itself. That is the second "study" of
   the cycle. It starts even if the screen turns off during the countdown (a short screen timeout)
   or you lock the phone: wake it and the block is already running, and its alert is already set.
7. Optional, recommended once: **swipe DualRep away** from the recent-apps screen while the focus
   block runs. Open it again: the block is still running, with the right time left.
8. **Finish.** Tap **Finish** at the top. A summary shows the blocks, focus minutes and sets. Tap
   **Back to Today**: Today's numbers count them. **History** lists the workout's sets by exercise
   name, and the focus blocks.

**Success:** all of this worked with airplane mode on, and no warning about saving appeared (see
[If something goes wrong](#if-something-goes-wrong)).

### Step 4: The gate, run 2, with a gym setup
You don't need to be at a gym. Stay in airplane mode.

1. **Add a gym setup.** Today → **More** → **Setups** → **Add a setup**. Under **Start from**, tap
   **Full gym**. Tap **Save setup**.
2. Optional: Settings → **Show weights in** → **kg**, to see the weight steps in kilograms.
3. Today → **Start a study block**. Focus block **10 min**. Tap the **Setup** chip and pick **Gym**.
   Under **Workout length**, pick **Full**, then **30 min** (a full session with straight sets, the
   other kind of workout). Tap **Start focus block**.
4. Run it as in step 3: the alert, the handoff, the sets (use **Skip rest** to move faster, and change
   the weight with − or + at least once), the 30-second countdown into the next block, then
   **Finish**.

**Success:** the same as run 1, with gym exercises (barbell, machine and cable moves).

### Step 5: Check the rows reached Postgres
1. Turn airplane mode off (and Wi-Fi back on). In Settings → **Sync**, wait for **Waiting to
   upload: 0**.
2. Today → **More** → **Sync check**: there should be no **Upload problems** card. If there is, read
   its code in [Troubleshooting](#the-row-never-reaches-postgres).
3. In the Supabase **SQL Editor**, run these one at a time:
   ```sql
   -- Focus blocks from the last day: 2 per run (the first ended by the timer, the second by Finish)
   select started_at, ended_at, planned_minutes, interrupted, effort_rating
   from public.interval_blocks
   where created_at > now() - interval '1 day'
   order by started_at;

   -- Handoffs: one per workout; accepted is true once a set was logged
   select t.created_at, t.accepted, w.kind, w.duration_minutes
   from public.transitions t
   left join public.workout_sessions w on w.id = t.workout_session_id
   where t.created_at > now() - interval '1 day'
   order by t.created_at;

   -- Sets: every row has a name, and linked is true
   select w.logged_at, w.kind, s.set_index, s.exercise_name, s.exercise_id is not null as linked,
          s.reps, s.target_reps, s.weight_lbs, s.rpe, s.set_type
   from public.exercise_sets s
   join public.workout_sessions w on w.id = s.workout_session_id
   where s.created_at > now() - interval '1 day'
   order by w.logged_at, s.set_index;
   ```
   - `interrupted` is true for a block ended early or by **Finish**.
   - `linked` false means the sets uploaded before step 1's migration. The history still works (it
     uses the name).
   - Weights are stored in pounds, even when the app shows kg. A timed exercise keeps its seconds in
     `reps`.

**Success:** both runs are there. **The Phase 1 gate has passed.** Tick it in
[ROADMAP.md](ROADMAP.md#your-manual-steps-for-the-gate-in-order).

### Step 6: Measure the alert delay (the Timer check)
Android may ring a scheduled alert late when the phone has been locked and still for a while (Doze
mode, which saves battery). This check measures by how much on your phone. The result decides
whether DualRep needs the optional exact-alarm setting ([DECISIONS.md](DECISIONS.md) D8 and D28).

1. Make sure alerts are on: Settings → **End-of-block alerts** says **On**. If it says **Not set
   up**, tap **Turn on alerts**. If it says **Off**, tap **Open system settings** and allow
   notifications for DualRep.
2. Today → **More** → **Timer check**. Pick **25 min** and tap **Schedule test alert**.
3. **Unplug the phone** (Doze only starts on battery), lock it and leave it still, for example face
   down on a table. Don't touch it until it rings. Online or in airplane mode makes no difference.
4. When it rings, **tap the alert** (on the lock screen, or in the notification shade after
   unlocking). The Timer check opens with the result: "Rang on time", or "Rang … late". Tap it
   rather than swiping it away: a swiped alert can't be measured ("Result lost": run it again).
5. Write the result in [ROADMAP.md](ROADMAP.md#your-manual-steps-for-the-gate-in-order) (Phase 1,
   step 8): the date, the phone, and the delay. A second run at another time of day helps.

What it means: if it rings within about a minute, the current timer stays as it is. If it is
regularly later than that, the next step is the optional exact-alarm setting
([ANDROID.md 1.3](ANDROID.md#13-exact-alarms-optional)).

**1 min** is a quick try to see the screen work; it is too short for Doze to start.

### Step 7 (optional): Load the exercise dataset
This loads free-exercise-db's 876 exercises into the database as **unreviewed** rows. Nothing changes
in the app until someone reviews rows (phones only receive reviewed library rows), so it is not
needed for the gate. The workflow's **Run workflow** button appears only once the Phase 1 pull request
is merged into `main` (step 8).

1. GitHub → **Actions → Exercise import SQL → Run workflow** (branch `main`). It takes a few minutes.
2. Download the artifact **`dualrep-exercise-import-sql`** at the bottom of the run and unzip it.
3. Open `dualrep-exercise-import.sql` in Notepad, select all (Ctrl+A) and copy.
4. Supabase **SQL Editor** → **New query** → paste → **Run**. It prints one row. The first time,
   `inserted` is 876.

Running it again later is safe: it never undoes a curator's fixes. The file is large (about 200 KB);
it hasn't been tried in the SQL Editor yet. If the editor struggles, get help to run it with `psql`.
How it works and how to review rows:
[`scripts/exercise-import/README.md`](../scripts/exercise-import/README.md).

### Step 8: Put the Phase 1 code on `main`
**Done on 2026-10-08** (pull request #3). For the record, how it went: when you are happy with the gate, merge it the same way as Phase 0
([section 4](#first-put-the-phase-0-code-on-main)): **Pull requests → New pull request**, base
`main`, compare `claude/bold-fermi-oglgch`, **Create pull request**, wait for the checks, then
**Merge pull request**.

If a check fails with "Failed to resolve latest Supabase CLI release: rate limit exceeded", that is
GitHub's download limit, not the code: open the run and click **Re-run failed jobs**.

### If something goes wrong
| What you see | What to do |
|---|---|
| "Couldn't put a workout together for this setup" (Just train), or a focus block went straight to "Next focus block in 0:30" with no workout | No exercise fit that setup and preset. Try another setup or preset, and tell whoever maintains the code which ones failed. |
| "Couldn't save on this phone. Trying again…" | The app retries by itself and the warning goes away when it works. If it stays for more than a minute, take a screenshot and get help. |
| "A change was not saved: …" | A bug in the app's write code: that one change was skipped so the loop could go on. Send a screenshot to whoever maintains the code. |
| The phone didn't ring when the block ended | Settings → **End-of-block alerts** must say **On**. Also check that DualRep's notifications aren't silenced in Android's settings. If you turned alerts on during a block, that block's alert is set as soon as you're back in DualRep (the cycle screen or Settings). The on-screen timer is right either way. |
| The block ended but the workout didn't appear | Open DualRep (or tap the alert). The handoff happens as soon as the cycle screen is open. |
| The next focus block didn't start after the workout | It starts when the 30-second countdown ends, even with the screen off or another app open; DualRep shows it the moment you open it, and its alert rings at its end. If you only come back more than 5 minutes after that block would have ended, the cycle finishes instead and shows its summary. |
| Timer check: "No alert could be scheduled" | Notifications aren't allowed yet: do step 6.1 first. |
| `linked` is false in step 5 | The sets uploaded before the step 1 migration. Nothing to fix; apply the migration before the next run. |

---

## 17. Phase 2: the study engine on your phone

Phase 2 turns your own course material into quiz cards and puts them inside the focus block. This
section sets up the server side, gets the new app onto your phone, and runs the gate:

> **A real course PDF and a page of handwritten notes become one cumulative plan, and a week of
> reviews runs correctly.**

You need Phases 0 and 1 working (the hosted Supabase project, PowerSync, the phone signed in), and
access to Tracy's service on Render. Plan on about **an hour for steps 1–7**, **an hour or two for
day 1 of the gate** (most of it waiting for the server), then **about 10 minutes a day for a week**.

What is new, in one paragraph: when you add material, the phone uploads it to a private folder in
Supabase Storage and asks a new Supabase **Edge Function** (`study`) to start. A second Edge Function
(`tracy-worker`) then works through the steps one at a time in the background, asking **Tracy** to
read pages, transcribe handwriting, propose an outline and write cards. The phone follows along
through sync. Studying the cards happens entirely on the phone and works offline. How it all fits
together: [DATA_MODEL.md](DATA_MODEL.md#the-study-pipeline) and
[DECISIONS.md](DECISIONS.md) D31–D49.

**Do the steps in this order.** Tracy has to be ready before the backend calls it, the database
before PowerSync, and PowerSync before the new app.

### Before you start: the secrets in this phase

A **secret** is a password one computer uses to talk to another. Each one below lives in exactly the
places listed, and nowhere else.

| Secret | What it is | Where it comes from | Where it goes |
|---|---|---|---|
| **Tracy secret** | The password DualRep's server uses when it calls Tracy. Tracy refuses any call without it. | You make it ([step 2](#step-2-make-the-tracy-secret)) | Your password manager; Render, as `SERVICE_SECRET_DUALREP` ([step 3](#step-3-set-up-tracy-on-render-then-merge-its-pull-request)); GitHub, as the secret `TRACY_SERVICE_SECRET` ([step 4](#step-4-add-the-github-secrets-and-variables)). The same value in both places. The Deploy backend workflow copies it from GitHub into Supabase's Edge Function secrets. |
| **Supabase access token** | Lets the **Deploy backend** workflow act as you on your Supabase account: it can change **every** project you own, so treat it like your Supabase password. | Supabase → Account → Access Tokens ([step 4](#step-4-add-the-github-secrets-and-variables)) | GitHub only, as the secret `SUPABASE_ACCESS_TOKEN` |
| **Worker secret** | Lets the database's every-minute schedule wake the worker. | Made for you by the Deploy backend workflow. You never see it. | Supabase only: an Edge Function secret (`DUALREP_WORKER_SECRET`) and a copy in Supabase Vault (`dualrep_worker_secret`) |
| **Gemini API key** (optional, not needed for the gate) | Lets the worker make search data (embeddings) for later features. | Google AI Studio, in a Google Cloud project **with billing turned on** | GitHub, as the secret `GEMINI_API_KEY`; the workflow copies it into Supabase's Edge Function secrets |

The other new names in this section are **settings, not secrets**: Tracy's web address
(`TRACY_URL`), your Supabase host name (`DUALREP_STORAGE_HOSTS`), the model name
(`TRACY_TASK_MODEL_STRONG`) and the Node version (`NODE_VERSION`). They are fine to see on screen.

Rules for every secret:

- **Never paste a secret into a chat** (with a person or an AI assistant), an email, a GitHub issue,
  a screenshot, `.env`, or any file in the repo. If you need help, share the error message, never
  the secret.
- **None of them ever goes into the app.** The phone only has the three public `EXPO_PUBLIC_…`
  values from Phase 0.
- GitHub and Render never show a secret again after you save it. That is normal: your password
  manager holds the Tracy secret if you need it again.
- **If one leaks:** make a new one and replace it everywhere it goes. For the Tracy secret: Render
  and GitHub, then run **Deploy backend** again ([step 5](#step-5-deploy-the-backend-a-dry-run-then-for-real)).
  For the Supabase token: delete it in Supabase (Account → Access Tokens) and make a new one. For the
  worker secret: run Deploy backend with **Make a new cron -> tracy-worker secret** ticked.

### Step 1: Check that Tracy is awake

Tracy runs on Render. Its address looks like `https://<name>.onrender.com`: Render shows it at the
top of the Tracy service's page (https://dashboard.render.com → the Tracy service). Write it down;
it is `TRACY_URL` in step 4.

1. In a browser, open `https://<name>.onrender.com/health`.
2. On Render's free plan Tracy sleeps after 15 minutes without visitors. The first visit wakes it,
   which can take **about a minute**: wait, then reload.

**Success:** the page shows a short line starting `{"ok":true,"assistant":"Tracy"`. If it never
loads, check the service's **Logs** on Render before going on.

### Step 2: Make the Tracy secret

You need one long random secret. Two ways; use either.

- **Your password manager's generator** (simplest): create a new item named "DualRep Tracy secret"
  and generate a password of **64 characters, letters and numbers only** (no symbols).
- **PowerShell:** this makes 64 random characters (digits and the letters a–f) and copies them to
  the clipboard without showing them:
  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) | Set-Clipboard
  ```
  Then paste it (Ctrl+V) into a new password-manager item named "DualRep Tracy secret". (Copy
  something else afterwards, so the secret doesn't stay on the clipboard.)

**Success:** the password manager holds the "DualRep Tracy secret". The secret is in no file and no
chat.

(Phase 2 has a second secret, the worker secret, but the Deploy backend workflow makes it for you in
step 5.)

### Step 3: Set up Tracy on Render, then merge its pull request

**3a. The four Render settings.** Changing them restarts Tracy (a few minutes; nothing else changes).

1. Open https://dashboard.render.com and click the **Tracy** web service.
2. In the left menu click **Environment**.
3. Add each of these with **Add Environment Variable** (**verify** the button's name): type the
   **Key**, then the **Value**.

   | Key | Value | What it does |
   |---|---|---|
   | `SERVICE_SECRET_DUALREP` | The Tracy secret from step 2 (paste it from your password manager) | Lets DualRep in, and only to DualRep's own tasks |
   | `DUALREP_STORAGE_HOSTS` | `<project-ref>.supabase.co`: your `EXPO_PUBLIC_SUPABASE_URL` **without** `https://` and without a slash at the end | The only place Tracy may download your files from. Without it, every PDF, Word file and photo is refused |
   | `TRACY_TASK_MODEL_STRONG` | `claude-sonnet-5-5` (the default, best quality), or `claude-haiku-5-5` to save money ([costs](#what-phase-2-costs-each-month)) | The Claude model that reads your material and writes the cards |
   | `NODE_VERSION` | `22` | Tracy's PDF reader needs Node 22 |

   If the list already has `SERVICE_SECRET` (Interverse's secret), leave it alone. It must be
   **different** from `SERVICE_SECRET_DUALREP`; if they were equal, Tracy would refuse DualRep. Leave
   every other variable as it is.

   **About the safety fallback** (`claude-sonnet-5-5` only): Tracy also asks Anthropic for its
   fallback. If Anthropic's safety checks decline a request (course material about computer security
   or AI can trigger this), Anthropic re-runs it on another Claude model in the same call. Nothing to
   do. To turn it off, add a fifth variable, `TRACY_TASK_FALLBACKS`, with the value `off`.
   `claude-haiku-5-5` has no such fallback.
4. Click **Save** (Render may offer **Save, rebuild, and deploy**, **Save and deploy** or **Save
   only**: any of them keeps the values; **verify** the labels).

**3b. Merge the tracy-ai pull request.** Render runs Tracy from the `main` branch, so the new
DualRep lane goes live when its pull request is merged.

1. Open https://github.com/FabianB14/tracy-ai → **Pull requests**. Open the Phase 2 pull request
   from `claude/bold-fermi-oglgch`. (No pull request yet? **New pull request**, set **base** to
   `main` and **compare** to `claude/bold-fermi-oglgch`, then **Create pull request** twice.)
2. Click **Merge pull request** → **Confirm merge**.
3. On Render, the Tracy service's **Events** list shows a new deploy. Wait until it says the deploy
   is live (a few minutes). If no deploy starts, use **Manual Deploy → Deploy latest commit**
   (**verify** the menu name).

**3c. Check it.** Open `https://<name>.onrender.com/diag` in the browser. Near the end there is a
`dualrepLane` part. It shows only yes/no and the model name, never a secret.

**Success:**
```json
"dualrepLane": { "configured": true, "storageHostsSet": true, "storageHostsLookValid": true, "strongModel": "claude-sonnet-5-5" }
```
(`strongModel` shows the model you chose.) `configured: false` means `SERVICE_SECRET_DUALREP` is
missing; `storageHostsSet: false` means `DUALREP_STORAGE_HOSTS` is missing. No `dualrepLane` at all
means the new Tracy isn't deployed yet. `storageHostsSet` only says the setting is there;
`storageHostsLookValid: true` says it has the right shape (a bare host name, no path or spaces).
Neither can tell a wrong project, so still check that it is exactly `<project-ref>.supabase.co`.

### Step 4: Add the GitHub secrets and variables

**4a. Make the Supabase access token.**

1. Open https://supabase.com/dashboard/account/tokens (or: click your account icon in the Supabase
   dashboard → **Account preferences** → **Access Tokens**; **verify** the menu names).
2. Click **Generate new token**. Name it `DualRep GitHub deploy`. If Supabase asks for an expiry
   date, a long one is easiest; when it expires, the workflow fails until you add a new one.
3. Copy the token (it starts with `sbp_`). Supabase shows it only once. Go straight to 4b.

**4b. The secrets.** Open https://github.com/FabianB14/DualRep → **Settings** → **Secrets and
variables** → **Actions**. On the **Secrets** tab, click **New repository secret** for each:

| Name | Secret |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | The token from 4a |
| `TRACY_SERVICE_SECRET` | The Tracy secret from step 2: **exactly** the value you gave Render as `SERVICE_SECRET_DUALREP` |
| `GEMINI_API_KEY` | **Skip for the gate.** Optional, and only from a Google Cloud project with billing turned on: on Google's free tier, what is sent may be used to improve Google's products and read by reviewers. Without it, embeddings are simply off ([DECISIONS.md](DECISIONS.md) D35) |

**4c. The variables.** Same page, **Variables** tab, **New repository variable**:

| Name | Value |
|---|---|
| `TRACY_URL` | Tracy's address from step 1, for example `https://tracy-xxxx.onrender.com` (no `/health`, no slash at the end) |
| `EXPO_PUBLIC_SUPABASE_URL` | **Already there** from Phase 0 ([section 10](#10-optional-the-github-actions-apk)). The workflow reads your project ref from it, so check it is `https://<project-ref>.supabase.co` |

`TRACY_URL` is a variable, not a secret: it is an address, not a password. Optional variables you
can leave out for now:

- `DUALREP_CAP_SOURCES_FREE`, `DUALREP_CAP_SOURCES_PAID`, `DUALREP_CAP_PAGES_FREE`,
  `DUALREP_CAP_PAGES_PAID`: the monthly limits per person. Unset means 5 sources and 20 pages a
  month on the free tier, 30 and 200 with a subscription or beta access. "Pages" are photos of notes
  **and** the scanned pages of PDFs (see step 7). `none` means no limit
  ([DECISIONS.md](DECISIONS.md) D36).
- `DUALREP_WORKER_CONCURRENCY`: how many study-builder steps may run at the same time, for everyone
  together. Unset means 1, which is right for Tracy on Render's free plan: two scanned-PDF pages
  being read at once can use up its memory. With a paid Render plan you could try `2`.
- `SUPABASE_PROJECT_REF`: only if `EXPO_PUBLIC_SUPABASE_URL` is a custom domain.

**Success:** the Secrets tab lists `SUPABASE_ACCESS_TOKEN` and `TRACY_SERVICE_SECRET`. The
Variables tab lists the three `EXPO_PUBLIC_…` variables and `TRACY_URL`.

### Step 5: Deploy the backend: a dry run, then for real

The **Deploy backend** workflow does everything on the Supabase side, from GitHub's computers: it
applies the new database migration, stores the Edge Functions' settings, makes the worker secret,
deploys the two Edge Functions, and tests them. You don't paste anything into the SQL Editor this
time.

**5a. First, put the Phase 2 code on `main`.** GitHub shows the **Run workflow** button only once the
workflow is on `main`, and a real deploy runs only from `main`. So this time the pull request is
merged **before** the gate. (If the gate finds a problem, the fix comes as a new pull request.)

1. https://github.com/FabianB14/DualRep → **Pull requests**. Open the Phase 2 pull request from
   `claude/bold-fermi-oglgch`. (None yet? **New pull request**, **base** `main`, **compare**
   `claude/bold-fermi-oglgch`, **Create pull request** twice.)
2. Wait for the checks: CI (including **Edge Functions (Deno check, lint, tests)** and the database
   tests) takes a few minutes, the Android APK build about 15.
3. When they are green: **Merge pull request** → **Confirm merge**.

If a check fails with "Failed to resolve latest Supabase CLI release: rate limit exceeded", that is
GitHub's download limit, not the code: open the run and click **Re-run failed jobs**.

**5b. The dry run.** It only shows what would change.

1. **Actions** → **Deploy backend** (in the list on the left) → **Run workflow** (on the right).
2. **Use workflow from:** `main`. Leave **Dry run (only show what would change)** ticked and **Make a
   new cron -> tracy-worker secret** unticked. Click **Run workflow**.
3. It takes about 2 minutes. Click the run when it appears, and read the summary at the top.

**Success:** a green check, and a summary like this:

- `Deploy backend (dry run)` and `Project:` your 20-letter project ref.
- `Schema found with an empty history: record 20261008000000 20261008120000 as applied`. This is
  the one-time fix for the two migrations you pasted by hand in Phases 0 and 1. (If you never ran
  the starter library's 7 parts, it names only `20261008000000`; then the real run applies the
  starter library too, which is safe.)
- `Function secrets to set: TRACY_URL TRACY_SERVICE_SECRET; to remove: none`.
- `Worker secret: create (Vault has it: 0, functions have it: 0); Vault project URL: https://…`.

In the run's log, the **Database migrations** step lists the migration files it would apply. On the
dry run this list still includes the two old ones (the dry run records nothing); the real run
records them first, so only `20261009120000_study_engine.sql` is applied. The **Edge Functions**
step ends with `Would deploy: study tracy-worker`.

A red X instead: open the failed step and find its message in
[If something goes wrong in Phase 2](#if-something-goes-wrong-in-phase-2).

**5c. The real run.** Same as 5b, but **untick Dry run**. It takes about 3–5 minutes (the last
step waits up to 90 s for Tracy to answer).

**Success:** a green check, and a summary that adds:

- `Migrations pushed`
- `Function secrets to set: TRACY_URL TRACY_SERVICE_SECRET; …` (and `GEMINI_API_KEY` if you set it)
- `Worker secret: create …`
- `Functions deployed: study, tracy-worker`
- `Tracy /health: OK` (a warning instead only means Tracy was slow to wake; check it in a browser)
- `Smoke test passed`

**5d. Optional: look in the Supabase dashboard.**

- **Edge Functions** lists `study` and `tracy-worker`.
- **Storage** lists a bucket named `sources`, marked private.
- In the **SQL Editor**:
  ```sql
  select jobname, schedule from cron.job order by jobname;
  -- dualrep-cron-history-cleanup | 17 3 * * *
  -- dualrep-storage-sweep        | 23 4 * * *
  -- dualrep-tracy-worker         | * * * * *
  select name from vault.secrets order by name;
  -- dualrep_project_url, dualrep_worker_secret (names only: never select the secret values)
  ```

Later deploys work the same way: merge the change into `main`, then run **Deploy backend** (a dry
run first if you like). Running it again with nothing new is harmless.

### Step 6: Update the PowerSync sync config

The sync config decides what reaches the phone. Phase 2 changed it: job rows (`tracy_events`) now
send three more columns, so the phone can show each source's progress. It must go **after** step 5:
PowerSync checks that the columns exist.

1. On GitHub, open
   [`powersync/sync-config.yaml`](../powersync/sync-config.yaml) on `main` and click **Copy raw file**
   (two overlapping squares, top right).
2. https://dashboard.powersync.com → your DualRep project → the `dualrep-dev` instance → the sync
   config editor (the tab is called **Sync Streams** or **Sync Config**; **verify**).
3. Select everything in the editor (Ctrl+A), paste (Ctrl+V), click **Validate**, then **Deploy**.
4. Wait until the deploy has finished (a minute or two).

(Set up with the command line in [8B](#8b-with-the-powersync-cli-config-as-code)? Then
`npx powersync deploy sync-config` in `C:\dev\dualrep`, after `git pull` on `main`, does the same.)

**Success:** validation shows no errors, and the instance's status is healthy. An error that names
`stage`, `plan_id` or `source_id` means step 5's real run hasn't finished: do that first.

### Step 7: Build and install the Phase 2 app

1. GitHub → **Actions** → **Android APK** → **Run workflow**. **Use workflow from:** `main`, variant
   `preview`. It takes 10–15 minutes.
2. Open the run when it has a green check. In its summary, **APK permissions (preview)** should name
   exactly these, in any order: the app's own
   `com.interverse.dualrep.preview.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, then `INTERNET`,
   `VIBRATE`, `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`
   (all as in Phase 1) and **`CAMERA`**, the only new one. `RECORD_AUDIO`, anything with `READ_MEDIA`,
   `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` or `FOREGROUND_SERVICE` must **not** appear
   ([ANDROID.md](ANDROID.md#permission-ledger)). If one does, the app still works for testing, but
   tell whoever maintains the code before going further.
3. Download **`dualrep-preview-arm64-apk`** at the bottom, unzip it, and install `app-release.apk`
   **over** the old app, as in Phase 1 ([§16 step 2](#step-2-build-and-install-the-phase-1-app)). You
   stay signed in.
4. Open DualRep **online**. Settings → **Sync**: wait for **Connected: Yes**.

**Success:** Today has a **Study** group with a **Study plans** row ("Turn your course material
into cards"), and Settings has **Answering cards** and **Daily review reminder**.

**Before day 1, give yourself beta access** ([section 14](#14-give-yourself-beta-access-for-testing)),
so the higher limits (30 sources and 200 pages a month) apply. This is not optional for the gate.
The 20 free pages a month are shared by photos of notes **and** every PDF page that has no text
layer: scanned pages, but also slides that are only a diagram or a picture. Such pages are read
from their image, and each one uses a page. A course PDF can use up all 20 before you add your
notes, and then the notes in step 8.6 are refused. Worse, the PDF's own picture pages over the
limit are skipped for good: "Try again" can't bring them back, only adding the file again after the
limit is raised (which uses another source).

### Step 8: The gate, day 1: one plan from a PDF and a page of notes

You need a **real course PDF** on the phone (in Downloads, or in Google Drive), up to 25 MB and
without a password, and **one page of handwritten notes** on paper. The phone must be **online**
for this day's building steps. Everything that happens on the server carries on if you switch to
another app or lock the phone; the plan screen updates when you come back.

**How long things take.** These are estimates: nothing has been timed on the real services yet.
Please write down what you see.

| Step on the plan screen | Roughly |
|---|---|
| "Waiting to start" | Under a minute; up to 2 minutes if Tracy was asleep |
| "Reading your material" (a 100-page PDF with a text layer) | 1–3 minutes. Scanned pages take longer: about 1–2 minutes per 4 pages |
| "Reading your material" (one photo of notes) | About a minute; up to 3 minutes while cards are being made (one step runs at a time, and the photo goes ahead of the cards still waiting) |
| "Making the outline" | 1–2 minutes |
| "Making cards (n of m)" | About 1–2 minutes per topic; a 15-topic course takes 15–30 minutes |

**8.1 Turn on the reminder** (for the week ahead). Settings → **Daily review reminder** → turn on
**Remind me when cards are due**, and pick a **Reminder time**. If Android asks whether DualRep may
send notifications, tap **Allow**.

**8.2 Make the plan.** Today → **Study plans** → **New plan**.
- **Name:** the course, for example "Biology 101".
- **What will you add?** **Growing course** ("Add each lecture as it comes; reviews mix everything
  so far"). The gate needs this kind.
- **Goal** and **Exam or deadline** are optional. An exam date makes new cards come a little
  sooner.
- Tap **Create plan**. The plan's screen opens: **0** due today, **0** new, **0** cards, "Nothing
  here yet…", and the button **Add material**. (Making a plan works offline; adding material doesn't.)

**8.3 Add the PDF.** Tap **Add material** → **File** → **Choose a file**, and pick the course PDF.
The **Name** is optional (it is shown next to each card's page). Tap **Add to plan**. The screen
shows "Getting the file ready…", "Uploading the file (40%)…", "Starting to read it…", then goes back
to the plan. **Stop** cancels ("Stopped. Nothing was added; tap Add to plan to start again.").
Trying again never adds the same material twice.

**8.4 Watch it work.** Under **Material**, the PDF shows a status that moves from "Waiting to start"
to "Reading your material" to "Making the outline". At the bottom: "Getting your
material ready. It carries on while you do something else."

**8.5 Review the outline.** When the PDF says **Review the outline** ("6 new topics"), tap the
**Review the outline** button at the bottom. For each topic under **New topics**:
- **Keep** or **Cut** it;
- change its **Name** if you like (once you do, the original suggestion shows under it);
- **Move up** / **Move down** to put the topics in your order.

Then tap **Save and make cards**. (Cutting every topic asks first.) Back on the plan, the PDF shows
"Making cards (0 of 6)" and counts up. Right after saving, the button may still say **Review the
outline** for a few seconds until the phone syncs; tapping it again is harmless.

**8.6 Add the page of notes** (you don't need to wait for the cards: the notes are read before
the PDF's remaining cards, once the topic being worked on is done). **Add material** →
**Photos**:
- **Take a photo**: the first time, Android asks to allow the camera: allow it. Photograph the page
  flat, in good light. (On Android 9 or older there is no camera button: take the photo with the
  camera app, then use the gallery.)
- or **Choose photos from the gallery** (it says **Add photos from the gallery** once you have one).

Each page can be moved up or down or removed. Tap **Add to plan** ("Uploading photo 1 of 1…").

**8.7 Check the transcription.** When the notes show **Check the transcription** ("1 page to
check"), tap that button. You see your photo and the text Tracy read from it ("Fix anything that
was misread, then confirm. Cards are made only from this text."). Correct any misread words; a
drawing shows as a `[Diagram: …]` line you can edit or delete. Your edits are kept on the phone as
you go. Tap **Confirm** (this needs the internet).

Then the notes go to "Making the outline", and either:
- **Review the outline** again, if the notes bring new topics: review them as in 8.5. Topics already
  in the plan are shown greyed under **Already in this plan**; or
- straight to **Making cards**, if the notes only add to topics you already have. The app approves
  that kind of outline by itself, because there is nothing new to decide.

**8.8 Look around.** When every source says **Ready**, the numbers at the top show your cards.
- **All cards** lists them by topic, each with when it comes back and where it came from ("p. 12,
  Lecture 3", or "Made by hand").
- Tap a card, then **See it on the concept map**: the card sits in the middle with its linked cards
  around it. Tap one to move it to the middle; **Link another card** adds a link.

**8.9 Study one block.** On the plan screen tap **Study now**. The start screen opens with your
plan picked under **What are you studying?** (the other choice is **Just a timer**). With two or more
sources, **Cards** offers **Everything so far** or **Newest source**: keep **Everything so far**.
Pick a block length (10 minutes is fine) and tap **Start focus block**.

The focus screen now has a small ring at the top and your cards below it:
- **Recall** cards (due reviews) come first: the question, **Show answer**, then **Missed it** or
  **Got it**. Under each button it says when the card comes back ("Back in 10 min", "Back in 3
  days").
- **New card**: the question and the answer together ("Read it, then test yourself"), then **Quiz
  me** hides the answer and asks you.
- In the last 2–5 minutes, a **Self-test** of this block's new and missed cards.
- If nothing is due for a moment: "Next card in 0:42" with **Ask now**; when everything is done:
  "All caught up".

When the timer ends, the workout appears as in Phase 1. Then **Finish**.

**Success for day 1:** one **Growing course** plan with two sources, the PDF and the notes, both
**Ready**; cards from both (open **All cards** and look for a card from your notes); and one study
block with answers.

### Step 9: The gate, days 2 to 7: a week of reviews

Once a day for the next six days (any time, any length of block):

1. If the reminder is on, it rings at your time on days with cards due: "Cards to review: 12 cards
   are due…". It shows only the count, never a card.
2. Today → the **Study plans** row says "12 cards due today". **Start a study block** (or **Study
   now** on the plan), with your plan picked.
3. Answer the **Recall** cards honestly, learn a few **New cards**, and do the **Self-test**.
4. Once during the week, do a block in **airplane mode** (like Phase 1), then go back online and
   check Settings → **Sync** reaches **Waiting to upload: 0**.

Write down each day: the date, how many cards were due, and anything odd.

**What "runs correctly" means:**
- On each day with cards due, the block starts with **Recall** cards.
- A card you get right comes back later each time (tomorrow, then a few days, then about a week).
  A card you miss comes back within minutes: later in the same block, or in the next one.
- The count on Today, on the plan and in the reminder agree on the same day.
- The reminder rings only on days with cards due (if it is on).
- No "Couldn't save that answer on this phone" message stays on screen, and Today → **More** → **Sync
  check** shows no **Upload problems** card.

### Step 10: Check the rows in Postgres

At the end of the week, online, with **Waiting to upload: 0**, run these in the Supabase **SQL
Editor**, one at a time. They show only counts, statuses and short error sentences, not your
material.

```sql
-- 1. Every job the pipeline ran, oldest first. Expect extract, transcribe, outline and cards jobs,
--    all succeeded (embed jobs only if you set GEMINI_API_KEY).
select created_at, job, stage, status, error
from public.tracy_events
order by created_at;

-- 2. Your sources: both ready, each with cards
select s.kind, s.status,
       (select count(*) from public.cards c where c.source_id = s.id) as cards
from public.sources s
order by s.created_at;

-- 3. A week of answers, per day (UTC days, so a late evening may count on the next day)
select (reviewed_at at time zone 'UTC')::date as day,
       count(*) as answers,
       count(*) filter (where rating = 1) as missed,
       count(*) filter (where prev_state = 0) as first_time
from public.reviews
where reviewed_at > now() - interval '8 days'
group by 1
order by 1;

-- 4. Where your cards stand: 0 new, 1 learning, 2 review, 3 relearning
select state, count(*) as cards, min(due) as next_due, max(reps) as most_reviews
from public.card_states
group by state
order by state;
```

**Success:** query 2 shows a `pdf` source and a `notes` source, both `ready` with cards; query 3
has a row for (nearly) every day of the week; query 4 has most cards in state 2, with `next_due`
dates spread out over the coming days and weeks. **The Phase 2 gate has passed.** Tick it in
[ROADMAP.md](ROADMAP.md#your-manual-steps-for-the-phase-2-gate-in-order), with your notes on how
long the steps took.

### If something goes wrong in Phase 2

**In the Deploy backend workflow** (open the failed step; the message is in red):

| Message | What to do |
|---|---|
| "Secret SUPABASE_ACCESS_TOKEN is missing (Supabase -> Account -> Access Tokens)." | Step 4a and 4b. |
| "A real deploy runs from main only (this is …). Use a dry run here." | Choose `main` under **Use workflow from**. |
| "Can't tell the project ref. Set the variable EXPO_PUBLIC_SUPABASE_URL to https://<ref>.supabase.co, or SUPABASE_PROJECT_REF to the 20-letter ref." | Check the `EXPO_PUBLIC_SUPABASE_URL` variable (step 4c). |
| "Missing variable TRACY_URL (https://…): the study builder can't reach Tracy without it." (or "Missing secret TRACY_SERVICE_SECRET") | Add it (step 4b or 4c). The dry run only warns; the real run stops. |
| "Could not read the remote migration history; nothing was recorded." | Run it again in a few minutes. If it repeats, get help (send the log, which holds no secrets). |
| An error mentioning "Unauthorized" or the access token | The token is wrong or expired: make a new one (step 4a) and replace the secret. |
| An error about `relation … already exists` in **Database migrations** | The hand-applied migrations weren't recorded. Don't run it again; get help with the log. |
| "Vault does not hold the new worker secret." | Run it again with **Make a new cron -> tracy-worker secret** ticked. |
| "tracy-worker should answer 403 (got …)." or "study should answer its own 401." | The functions didn't deploy properly. Run it again; if it repeats, get help with the log. |
| Warning: "Tracy's /health did not answer in 90 s." | Only a warning. Open Tracy's `/health` in a browser (step 1). |

**On Render and Tracy:**

| What you see | What to do |
|---|---|
| `/diag` has no `dualrepLane` | The tracy-ai pull request isn't merged or deployed yet (step 3b). |
| `configured: false` / `storageHostsSet: false` | Add `SERVICE_SECRET_DUALREP` / `DUALREP_STORAGE_HOSTS` (step 3a). |
| Tracy's log says "SERVICE_SECRET_DUALREP equals SERVICE_SECRET…" | The two must differ: make a new Tracy secret (step 2), then update Render and GitHub and run Deploy backend. |
| "A page here was scanned at too high a resolution to read. Skip it to carry on." | A scanned page in that batch needs more memory to turn into a picture than Tracy has on Render's free plan (a page scanned at more than about 600 dpi, or a very large photo). Tap **Skip this page** to carry on without that batch, or scan the page again at 300 dpi and add it as new material. |
| Tracy keeps restarting, or reading big PDFs is very slow | Render's free plan has little memory and CPU. Tracy reads each PDF in a separate process that it stops when it uses too much memory (the file then fails with "The file is too large to read."), and the study builder sends it one step at a time. If Tracy still restarts: on Render, set `EXTRACT_MAX_PAGES` to `40`, or move Tracy to a paid plan. A file that crashes Tracy now fails after three tries instead of being sent again every minute. |
| `/diag` says `storageHostsLookValid: false` | `DUALREP_STORAGE_HOSTS` has a typo: it must be just `<project-ref>.supabase.co` (a pasted `https://…/` is cleaned up for you, anything else is not). |

**Adding material** (the "Not added" box on Add material, or "That didn't work" on the plan):

| The app says | What to do |
|---|---|
| "No internet connection. Adding and preparing material needs the internet; studying doesn't." | Go online and tap the button again. What you picked is kept. |
| "Adding material isn't set up on the server yet. Try again later." | The `study` function isn't deployed: step 5c. |
| "Your session has expired. Sign in again, then try again." | Sign out and in again (online, after **Waiting to upload: 0**). |
| "You've used all 5 sources for this month. More can be added from November 1." (or "… handwritten and scanned pages …"), or "That's more than this month's limit allows: 15 of 20 handwritten and scanned pages used, 5 left." | The monthly limit. In the second case what you added is more than is left this month: add fewer photos (5 here) or wait for the reset. The page limit counts photos of notes and the PDF pages that had to be read from their image (scans, picture-only slides), so a scanned PDF can use it up before any notes. For testing: beta access ([section 14](#14-give-yourself-beta-access-for-testing)), or a higher `DUALREP_CAP_…` variable (step 4c) and Deploy backend again. |
| "This plan isn't on the server yet. Wait a moment for it to sync, then try again." | A plan made offline hasn't uploaded. Settings → **Sync** must say **Connected: Yes** and **Waiting to upload: 0**. |
| "… is larger than 25 MB." / "Only PDF and Word (.docx) files can be added." / "Up to 20 photos per set of notes…" | The limits. Split a big PDF, or save an old `.doc` as `.docx`. |
| "Use a web address that starts with https://." | Links must be public `https://` pages. |
| "Camera access is off" | **Open system settings** and allow the camera, or use the gallery. |

**A source's status says "Couldn't finish"** (with **Try again** next to it):

| The reason under it | What it means | What to do |
|---|---|---|
| "The study builder isn't set up yet. Try again later." | Tracy refused the worker: the tracy-ai pull request isn't live, `TRACY_SERVICE_SECRET` (GitHub) differs from `SERVICE_SECRET_DUALREP` (Render), or `DUALREP_STORAGE_HOSTS` isn't exactly `<project-ref>.supabase.co` | Check `/diag` (step 3c) and both secrets. After changing the GitHub secret, run Deploy backend again. Then **Try again**. |
| "Tracy couldn't finish this step. Try again." / "Tracy didn't answer in time. Try again." | Three attempts failed (Tracy slow, or restarting while it worked on this file) | Open Tracy's `/health`, then **Try again**. If the same file fails like this every time, Tracy may be running out of memory on it: see "Tracy keeps restarting" above. If the very first job fails like this while Tracy is awake, the safety fallback may not mix with Tracy's request format (not yet tested live): add `TRACY_TASK_FALLBACKS` = `off` on Render (step 3a), wait for the restart, then **Try again**. |
| "Tracy couldn't be reached for a while. Try again later." | For about a quarter of an hour, every try found Tracy not answering at all (its `/health` failed): Render suspended it, or `TRACY_URL` is wrong | Open Tracy's `/health` in a browser (step 1). If it doesn't answer, check the service on Render. If it does, check the `TRACY_URL` variable (step 4c) and run Deploy backend again. Then **Try again**. |
| "This step took too long. Try again." | A step was cut off three times | **Try again**. If it repeats on a big PDF, see "Tracy keeps restarting" above. |
| "Tracy declined to work on this material." | Anthropic's safety checks refused it (possible with some biology, medicine, chemistry or security material) | Try a different part of the course. If proper course material keeps being refused, you can set `TRACY_TASK_MODEL_STRONG` to `claude-haiku-4-5` on Render for it, tap **Try again**, and switch back afterwards. |
| "This PDF is password-protected. Upload a copy without a password." / "This PDF couldn't be read." / "No readable text was found." | The file itself | Use another copy of the file. |
| "Tracy's answer didn't pass the checks. Try again." | The model's answer was rejected three times | **Try again**. |
| "This part was too long to process. Try again." | The outline (or a topic's cards) came back cut off three times. For an outline, each try already sent a shorter summary of the material (big documents are summarised a few passages at a time) | **Try again**: it starts from the shortest summary. If it repeats, split the PDF into two files and add them one at a time. |
| "This month's page limit is used up, so the scanned pages weren't read." (or, under **Ready**, "4 scanned pages weren't transcribed: this month's page limit is used up.") | A PDF had more pages without a text layer (scans, picture-only slides) than the monthly page limit allowed | Beta access or a higher `DUALREP_CAP_PAGES_…` (above). Pages skipped for the limit are not read later by **Try again**: after raising the limit, add the file again as new material (that uses another source). |
| "Every page was skipped, so there is nothing to study yet." | Every page of these notes was skipped | **Try again** reads the last skipped page again. |
| Any reason, on a page of notes or a scanned page, with **Skip this page** below it | That page's transcription failed | **Try again**, or **Skip this page** to go on without it. The last page of a set of notes that isn't skipped can't be skipped (there would be nothing left): **Try again**. |
| Any reason on a source that was already **Ready** | One topic's cards couldn't be made (other topics have theirs) | **Try again** for that topic. Until then the topic shows "Making cards" with no cards. |

**A source stays on "Waiting to start" for more than 5 minutes:** the worker isn't being woken. In
the SQL Editor:
```sql
select start_time, status, return_message from cron.job_run_details
where command like '%kick_tracy_worker%' order by start_time desc limit 5;
select status_code, created from net._http_response order by created desc limit 5;
```
No rows in the first: the schedule isn't there (step 5c didn't finish). Status `403` in the second:
the worker secret doesn't match: run Deploy backend with **Make a new cron -> tracy-worker secret**
ticked. Supabase dashboard → **Edge Functions** → `tracy-worker` → **Logs** shows one line per step
(no material in it).

**Checking the transcription or the outline** (the "Not confirmed" or "Not saved" box):

| The app says | What to do |
|---|---|
| "Some pages are still being transcribed." | Wait until every page shows its text. |
| "A page could not be transcribed. Try it again or skip it first." | On the plan, **Try again** or **Skip this page** for that page. |
| "There is nothing to study in these pages yet. Type the notes into the transcript first." | Every page is empty: type the notes in, then **Confirm**. |
| "There is no outline to review yet." / "No outline to review" | It was already saved, or the outline isn't made yet. Go back to the plan. |
| "Not saved" after **Save and make cards** | Nothing was changed (the save is all or nothing). Check you are online and tap **Save and make cards** again. |

**Studying and the reminder:**

| What you see | What to do |
|---|---|
| The start screen shows only the "What are you studying?" text box | No study plan is on this phone yet: make one under **Study plans**. |
| "Your material is being prepared." in the focus block | Its cards aren't made yet; the block runs as a plain timer. |
| "Couldn't save that answer on this phone. Try again." | Tap the answer again; the same answer is never saved twice. If it stays, take a screenshot and get help. |
| The reminder didn't ring | Settings → **Daily review reminder** must be on, and notifications allowed ("Notifications are off for DualRep…" shows if not). It rings only on days with cards due. If you ignore it, it rings again the following days (up to two weeks) until you open the app. |
| A card I wrote by hand never comes up | It is asked in every block of its plan, after the material's own new cards. If it still doesn't, check it isn't in a topic that is still a draft. |
| A typed answer like "mitosis or meiosis" was marked wrong | On purpose: an answer that names two things, says "not …", or uses the opposite prefix ("hypertonic" for "hypotonic") is not counted as right by itself. Tap **Count it as right** if it was. |
| **Take a photo** is missing | The phone runs Android 9 or older: use the gallery. |

### What Phase 2 costs each month

Everything except the AI calls stays on free plans. Prices are from the Phase 2 research
(2026-10-09); the AI costs are **estimates, not measurements**. After the gate, the real numbers are
in Anthropic's console (**Usage**).

| Service | Cost | Notes |
|---|---|---|
| Supabase | $0 (Free plan) | Limits that matter now: 500 MB database, 1 GB of file storage, 500,000 Edge Function calls a month (the every-minute schedule only calls the worker when there is work), 5 GB of downloads (egress). Tracy downloading the files counts as downloads: a scanned PDF is read in batches of 4 pages, and Tracy keeps the file it read last and only checks with Supabase that it hasn't changed, so a 25 MB scan should cost about 25 MB, not 25 MB per batch (**verify** in the dashboard's **Usage** after the first big scan). Over 5 GB in a month, Supabase restricts the project (sync and uploads stop until the next month): watch **Usage** in the Supabase dashboard if many large scans are added. A free project is paused after a week with little activity (**verify** the rule); restoring it is a click. |
| PowerSync | $0 (Free plan) | As in Phase 0. |
| Render (Tracy) | $0 (free plan) | Sleeps after 15 idle minutes and takes about a minute to wake; the worker copes with that by itself. A paid instance never sleeps and reads PDFs faster (**verify** the price on render.com). |
| GitHub Actions | $0 | Each Deploy backend run uses a few minutes of the monthly allowance. |
| Gemini (embeddings) | $0 (off) | If you turn it on, with billing: about $0.012 per 100-page PDF. |
| **Anthropic (through Tracy)** | **pay per use** | See below. Studying costs nothing: reviews happen on the phone. |

**Anthropic, per piece of material** (`TRACY_TASK_MODEL_STRONG`):

| | `claude-sonnet-5-5` (default) | `claude-haiku-5-5` |
|---|---|---|
| Price per million tokens, in / out | $2 / $10 | $0.10 / $0.50 (prompts up to 100,000 tokens) |
| A 100-page course PDF (outline and cards; reading a text PDF is free) | about **$1.10** (likely $0.80–$1.80) | about **$0.06** |
| One handwritten page | about **$0.03** | about **$0.002** |
| Safety fallback on another model ([step 3a](#step-3-set-up-tracy-on-render-then-merge-its-pull-request)) | Yes | No |

(For comparison, `claude-haiku-4-5`: about $0.34 per 100-page PDF and $0.006 per handwritten page,
and it reads photos at a lower resolution.)

**Per month, roughly:**

| Who | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|
| You, running the gate (one 100-page PDF, a page of notes, a retry or two) | about $1–3 | under $0.20 |
| A free user at the limit, with short lectures (5 PDFs of about 30 pages, 20 pages of notes) | about $2.40 | about $0.15 |
| A free user at the limit, worst case (5 PDFs of 100 pages, 20 pages of notes) | about $6 | about $0.35 |
| A subscriber at the limit, worst case (30 PDFs of 100 pages, 200 pages of notes) | about $39 | about $2.20 |

Choosing: the gate is a good time to see Sonnet 5.5's cards. Haiku 5.5 is about 20 times cheaper,
but nobody has compared its cards on DualRep's material yet. To compare, change
`TRACY_TASK_MODEL_STRONG` on Render (step 3a) and add the same PDF to a second test plan; only
material added after the change uses the new model. Whatever you choose, these Anthropic costs share
Tracy's account and its monthly spend limit: setting a monthly limit in Anthropic's console
(**Settings → Limits**, **verify**) protects you from surprises.
