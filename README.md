# AC Timer For HA 🌡️⏱️

כרטיסייה מותאמת ל-Home Assistant שמאפשרת להגדיר טיימר **דינמי** על ידי גרירה — גורר את הקו ל-17 דקות, משחרר, והפעולה תרוץ בעוד 17 דקות.

הספירה רצה **בצד השרת** (ישות `timer`), כך שהיא שורדת סגירת אפליקציה/נעילת טלפון. הכרטיסייה גנרית: שליטה מלאה בצבעים ופעולת-סיום מתכווננת, כך שאפשר להשתמש בה לכיבוי מזגן, בוילר, תאורה, או כל דבר אחר.

> **עיצוב 1** (הנוכחי): track אופקי בכיוון RTL — 0 בימין, מקסימום בשמאל. עיצובים נוספים יתווספו בהמשך.

---

## איך זה עובד

```
גרירה בכרטיסייה ──▶ timer.start (משך דינמי) ──▶ timer.ac_off סופר בשרת
                                                        │ timer.finished
                                                        ▼
                                           פעולת הסיום (אחת מהשתיים):
                                           A) finish_action בכרטיסייה  (צד-לקוח)
                                           B) אוטומציה על timer.finished (צד-שרת)
```

### שתי דרכים להריץ משהו בסוף הספירה

| | A. `finish_action` בכרטיסייה | B. אוטומציה (`timer.finished`) |
|---|---|---|
| היכן מוגדר | בקונפיג של הכרטיסייה / בעורך | באוטומציות של HA |
| מתי נורה | כשהאפליקציה **פתוחה** | תמיד, גם כשהטלפון נעול |
| מתאים ל | כרטיסייה גנרית רב-שימושית, נוחות | כיבוי מובטח |
| תמיכה | קריאות service (script/scene/automation/כל service) | כל פעולה שאפשר ב-HA |

> **השתמש רק באחת מהן לכל timer** כדי למנוע הרצה כפולה. לכיבוי שחייב לקרות גם כשהטלפון נעול — בחר B.

---

## התקנה

### 1. הכרטיסייה (HACS)

1. HACS → תפריט שלוש נקודות → **Custom repositories**
2. הוסף את כתובת ה-repo, קטגוריה: **Lovelace** (Dashboard)
3. חפש **AC Timer For HA** → התקן
4. אם ה-resource לא נוסף אוטומטית — *Settings → Dashboards → ⋮ → Resources*:
   - URL: `/hacsfiles/AC-Timer-For-HA/ac-timer-card.js`
   - Type: `JavaScript Module`
5. רענן בכוח את הדפדפן (Ctrl+Shift+R).

### 2. ה-Timer helper

Settings → Devices & Services → Helpers → Create Helper → **Timer**, בשם למשל `AC Off` → נוצר `timer.ac_off`. ראה [`examples/timer-helper.yaml`](examples/timer-helper.yaml).

### 3. פעולת הסיום

- **דרך A** — הגדר `finish_action` בכרטיסייה (ראה למטה). הכי פשוט ורב-שימושי.
- **דרך B** — אוטומציה מ-[`examples/automation.yaml`](examples/automation.yaml) שמריצה את סקריפט הכיבוי שלך (שגם מעדכן את `input_text.salon_ac_status` ל־"המזגן כבוי" — ראה [`examples/turn-off-script.yaml`](examples/turn-off-script.yaml)).

---

## הגדרה (Lovelace)

הכי קל — דרך **העורך הויזואלי** (בוחרי צבעים, בורר ישות, ועורך פעולה מלא). או ב-YAML:

```yaml
type: custom:ac-timer-card
timer_entity: timer.ac_off
title: טיימר כיבוי מזגן
max_minutes: 120
min_minutes: 1
step: 1

# פעולת סיום (צד-לקוח). תומך ב-service אחד או רשימה:
finish_action:
  - action: script.turn_on
    target:
      entity_id: script.ac_turn_off

# שליטה מלאה בצבעים (אופציונלי). אפשר [r,g,b] או מחרוזת CSS:
colors:
  accent: [63, 158, 255]        # מילוי — צבע א׳
  accent2: [123, 97, 255]       # מילוי — צבע ב׳
  running_from: [46, 125, 107]  # ספירה פעילה — צבע א׳
  running_to: [63, 158, 255]    # ספירה פעילה — צבע ב׳
  track_bg: 'rgba(255,255,255,0.08)'
  handle: '#ffffff'
  value: [255, 255, 255]        # צבע המספר הגדול
  title_color: [255, 255, 255]
  sub: [160, 160, 160]
  cancel: [255, 82, 82]
```

| אפשרות | ברירת מחדל | תיאור |
|---|---|---|
| `timer_entity` | — (חובה) | ישות ה-`timer` שהכרטיסייה שולטת בה |
| `title` | `טיימר כיבוי מזגן` | כותרת |
| `max_minutes` | `120` | דקות בקצה השמאלי |
| `min_minutes` | `1` | מינימום להפעלה |
| `step` | `1` | רזולוציית הגרירה בדקות |
| `finish_action` | — | service אחד או רשימה שירוצו בסיום (צד-לקוח) |
| `colors` | — | בלוק צבעים, ראה למעלה |

**משבצות צבע:** `accent`, `accent2`, `running_from`, `running_to`, `track_bg`, `handle`, `value`, `title_color`, `sub`, `cancel`.

---

## התנהגות

- **idle:** גרירה מציגה דקות בזמן אמת. שחרור → `timer.start`.
- **active:** הפס מתכווץ, תצוגת `HH:MM:SS` יורדת. **ביטול** → `timer.cancel`.
- **paused:** מציג זמן שנותר עם תווית "מושהה".
- **בסיום:** אם הוגדר `finish_action` והאפליקציה פתוחה — הוא נורה.

---

## פיתוח

[`dist/ac-timer-card.js`](dist/ac-timer-card.js) — Vanilla Custom Element, **ללא build**. עורכים ומרעננים בכוח את הדפדפן. גרסה: `0.2.0`.
