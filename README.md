# Timelog

A small personal time log. Type what you're doing and press **Start**. The app records the time you started, which also ends the previous activity. The **Log** tab shows your stats and history. You can edit entries there and export everything.

- **Now**: start an activity (or tap a recent one), back-date the start ("15m ago", "at 14:05"), stop tracking, and see today's timeline.
- **Log**: pick a range (today, yesterday, 7 or 30 days, this month, all, custom). You get totals, a per-day chart and a breakdown by activity or by `#tag`. Below that is every entry, which you can click to edit.
- **Manual edits**: change the name, start, end or note. You can add a past entry, for example a phone call in the middle of a work block, and choose whether you went back to the work afterwards. You can also delete entries or mark time as untracked.
- **Export**: CSV for the current range or for everything (opens in Excel or Sheets, Hebrew works), plus a JSON backup you can restore later.
- **Colors**: tap a colored dot in the Log's breakdown or chart legend, or use "change" in the edit dialog, to pick a color for an activity or tag. Colors you don't set are assigned automatically. Your choices sync across devices.
- **Tags**: write `#something` anywhere in an activity name (`Report draft #work`) to group activities by tag.
- Works offline and syncs when you're back online. Add it to your phone's home screen to use it like an app.

It's plain HTML, CSS and JavaScript, so there's no build step. Pages are served by GitHub Pages and the data lives in Firebase (Firestore), under your Google sign-in.

---

## Setup (about 10 minutes)

### 1. Put it on GitHub Pages

1. Create a new repository on GitHub, e.g. `timelog`. It can be public: no secrets are stored in the code.
2. Upload all of these files to the repo root (drag and drop on github.com works, or use `git push`).
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and click **Save**.
4. After a minute your app is live at `https://<your-username>.github.io/timelog/`.

At this point it already works in **local mode**, which saves data in that browser only. Do step 2 to sync across devices.

### 2. Create the Firebase database

1. Go to <https://console.firebase.google.com>, click **Create a project**, and give it a name. Google Analytics isn't needed.
2. **Sign-in**: in the left menu, open **Build → Authentication → Get started → Sign-in method → Google**, then **Enable** and **Save**.
   - Still in Authentication, open **Settings → Authorized domains → Add domain** and add `<your-username>.github.io`.
3. **Database**: open **Build → Firestore Database → Create database**. Choose a location near you (e.g. `europe-west`) and **production mode**.
   - Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**. These rules let each signed-in user read and write only their own data. If you update the app later and `firestore.rules` changed, paste and publish it again.
   - Optional: to lock the app to your Google account only, use the commented email line in the rules.
4. **Connect the app**: open **Project settings** (the gear icon) **→ General → Your apps** and click the **Web** icon `</>`. Register the app (Firebase Hosting isn't needed) and copy the `firebaseConfig` object it shows.
5. Open `js/config.js` in your repo, replace `export const firebaseConfig = null;` with the copied object, and commit.

Reload the site and click **Sign in with Google**. You're done. If you logged anything in local mode first, open the **⋯** menu and choose **Upload entries saved on this device** to move it into your account.

Firebase's free (Spark) plan is plenty for a personal log like this.

### Running it locally

ES modules don't load from `file://`, so serve the folder instead:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

`localhost` is already an authorized domain in Firebase, so sign-in works locally too.

---

## How the data works

Each entry is a single moment: *"at `start`, I started `activity`"*. An entry lasts until the next one starts. Stopping adds an entry with no activity, which marks untracked time. Because of this model, adding an entry in the middle of a block, or changing an end time, adjusts the neighbouring entry for you.

Firestore paths:
- `users/{uid}/entries/{id}` → `{ activity: string|null, start: epoch-ms, note: string, updatedAt }`
- `users/{uid}/settings/prefs` → `{ colors: { "<activity name, lowercase>" or "#tag": "#rrggbb" } }`

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout |
| `css/style.css` | Styling (light and dark mode) |
| `js/app.js` | UI, stats, editing, export |
| `js/store.js` | Storage: local (browser) or Firebase |
| `js/config.js` | Your Firebase config (or `null` for local mode) |
| `firestore.rules` | Security rules to paste into Firebase |
| `manifest.webmanifest`, `icon*` | Home-screen app icon and metadata |

Keyboard shortcut: press `/` on the Now tab to jump to the input.
