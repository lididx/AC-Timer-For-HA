# AC Timer For HA ⏱️

A custom Home Assistant Lovelace card that lets you set a **dynamic countdown by dragging** — drag the bar to 17 minutes, release, and your chosen script/automation runs in 17 minutes.

The countdown runs **server-side** (a `timer` entity), so it's shared across everyone viewing the dashboard and survives the app being closed.

## Install

1. **HACS** → ⋮ → **Custom repositories** → add this repo, category **Lovelace** → Install.
2. Edit your dashboard → **Add Card** → **AC Timer Card**.
3. In the card editor, pick **Run on finish** (the script/scene/automation to run) and your colors.

That's it. No helpers to create, no YAML to write — the card creates its own timer behind the scenes. Drag to set the minutes, release to start.

## Credit

Created by **Lidor Nahum**.
