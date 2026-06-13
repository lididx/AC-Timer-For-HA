# AC Timer For HA ⏱️

A custom Home Assistant Lovelace card that lets you set a **dynamic countdown by dragging** — drag the bar to 17 minutes, release, and your chosen script/automation runs in 17 minutes.

The countdown runs **server-side** (a `timer` entity), so it's shared across everyone viewing the dashboard and survives the app being closed. You configure once which action runs when the timer ends.

## Install

### Via HACS
1. HACS → ⋮ → **Custom repositories** → add this repo, category **Lovelace**.
2. Search **AC Timer For HA** → Install.
3. If the resource isn't added automatically, add it under *Settings → Dashboards → ⋮ → Resources*:
   - URL: `/hacsfiles/AC-Timer-For-HA/ac-timer-card.js`
   - Type: `JavaScript Module`
4. Hard-refresh the browser (Ctrl+Shift+R).

### Setup
1. Create a **Timer** helper (Settings → Devices & Services → Helpers), e.g. `timer.ac_off`.
2. Add the card to your dashboard and configure it (visual editor or YAML):

```yaml
type: custom:ac-timer-card
timer_entity: timer.ac_off
title: AC Shutoff Timer
max_minutes: 120
finish_action:
  - action: script.turn_on
    target:
      entity_id: script.your_off_script
```

That's it — drag to set the minutes, release to start. Colors and the finish action are fully configurable in the card's visual editor.

## Credit

Created by **Lidor Nahum**.
