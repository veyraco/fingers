# Customize Fingers with themes

Themes control the colors Fingers uses in interactive mode and HTML exports. Fingers includes the `system`, `dark`, and `light` themes. You can select one theme, follow your terminal's light or dark appearance, or create your own palette.

## Use your terminal's colors

The `system` theme is the default. It builds Fingers' colors from your terminal's theme, so Fingers matches the terminal instead of bringing its own palette:

- Fingers queries the terminal's default foreground and background colors and its 16 ANSI colors.
- Each Fingers color takes its hue from one ANSI color, for example errors from red and links from blue.
- Fingers sets each color's lightness so that it stands out from the background by a minimum contrast. Body text keeps at least a 4.5:1 WCAG contrast ratio on the background and every panel.
- When the terminal switches between light and dark, Fingers queries the colors again and rebuilds the theme.

The theme adapts to what the terminal reports:

| Terminal reports | Result |
|---|---|
| Background and ANSI colors | Colors from the terminal palette, placed for the actual background. |
| Background only | Fingers' own hues, placed for the actual background. |
| Nothing | ANSI color indices and the terminal's default colors, which the terminal renders itself. Secondary text is faint, and panels have no background color. |

Fingers asks the terminal for its colors when it starts. Terminals usually answer within a few milliseconds, and Fingers waits at most 100 ms before showing the startup header. If the terminal does not answer in time, Fingers uses the ANSI color fallback, and it still applies the colors if they arrive later, for example over a slow SSH connection. `system` is a reserved name: a custom theme with that name is ignored.

<a id="selecting-a-theme"></a>

## Choose a theme

Open `/settings` and select **Theme**. You can use one theme for every terminal appearance or choose separate themes for light and dark terminals.

The selection is saved as the `theme` [setting](settings.md#terminal-and-display):

```json
{
  "theme": "dark"
}
```

Without a `theme` setting, Fingers uses `system`.

Automatic mode stores the light theme first and the dark theme second:

```json
{
  "theme": "light/dark"
}
```

Fingers decides whether the terminal is light or dark from its reported background and foreground colors. If the terminal does not report its background, Fingers uses the terminal's light/dark notification, then the `COLORFGBG` environment variable, then dark. The same decision picks the theme of a light/dark pair and the appearance of `system`. When automatic mode is active, Fingers changes themes when the terminal reports an appearance change. Theme names cannot contain `/` because Fingers reserves it for this setting format.

Use `--use-theme` to choose the initial theme for one invocation without changing the saved setting:

```bash
fingers --use-theme light
fingers --use-theme light/dark
```

See [CLI resources](cli.md#resources) for the command-line option.

## Create a custom theme

Copy one of the [built-in themes](https://github.com/veyraco/fingers/tree/main/packages/coding-agent/src/modes/interactive/theme) or create a new JSON file conforming to the [schema](https://raw.githubusercontent.com/veyraco/fingers/main/packages/coding-agent/schemas/theme.schema.json). The built-in themes use OKHSL colors, with variables for colors that several roles share, so you can adjust a hue, saturation, or lightness directly.

1. Save the file as `<agent-dir>/themes/my-theme.json`. The agent directory defaults to `~/.fingers/agent`.
2. Set its `name` to `my-theme`.
3. Change values in `vars` and `colors`.
4. Select `my-theme` through `/settings`.

Use the theme name as the filename. Fingers hot-reloads the active user theme only from `<agent-dir>/themes/<name>.json`. Run `/reload` after adding or changing a theme from any other source.

## Understand the theme file

| Property | Required | Responsibility |
|---|---|---|
| `$schema` | No | Enables editor validation and completion against Fingers' published schema. |
| `name` | Yes | Identifies the theme in selectors and settings. It must be unique, cannot contain `/`, and cannot be `system`. |
| `appearance` | No | `"dark"` or `"light"`: the background the theme is designed for. Fingers detects it from the theme colors when omitted. |
| `vars` | No | Defines reusable color values. Variables can reference other variables. |
| `colors` | Yes | Assigns colors to terminal UI roles. The schema identifies required and optional roles. |
| `export` | No | Overrides page and panel backgrounds in HTML exports. |

Theme objects are strict: only documented top-level fields and color tokens are accepted. Define reusable custom colors under `vars`; custom keys under `colors` or `export` and additional top-level metadata are rejected.

A color can be written in six forms:

| Form | Example | Meaning |
|---|---|---|
| RGB hexadecimal | `"#0af"` or `"#00aaff"` | A three- or six-digit sRGB color. |
| OKLCH | `"oklch(62% 0.1 200)"` | Perceptual lightness, chroma, and hue. |
| OKHSL | `"okhsl(250 60% 55%)"` | Hue, saturation, and lightness. Saturation is relative to the most the sRGB gamut allows at that hue and lightness, so every value is in gamut and equal saturation looks equally colorful. |
| 256-color index | `39` | An ANSI palette index from `0` through `255`. |
| Variable reference | `"primary"` | The value of an entry in `vars`. |
| Terminal default | `""` | The terminal's default foreground or background color. |

Terminal default colors render as the terminal's own colors. Where Fingers needs a concrete value, such as HTML export or extension color math, it uses the default colors the terminal reports, or a black or white guess based on the theme's appearance.

Fingers resolves chained variable references. A missing variable or circular reference makes the theme invalid. Fingers uses truecolor when available, gamut-maps OKLCH to sRGB, and approximates colors for 256-color terminals. HTML exports convert OKHSL values to hexadecimal because CSS does not support them. If colors differ from their source values, check your terminal's truecolor detection and contrast settings. See [Configure Your Terminal](terminal-setup.md#override-detected-capabilities).

Use the [theme JSON schema](https://raw.githubusercontent.com/veyraco/fingers/main/packages/coding-agent/schemas/theme.schema.json) for the exact properties, required colors, and accepted value types.

Fingers reports invalid theme files during startup and `/reload`.

## Find the color to change

Theme colors describe interface roles rather than individual components. Use these groups to find the relevant part of the schema:

| Area | Color names |
|---|---|
| General interface | `accent`, `border*`, `text`, `muted`, `dim`, `success`, `error`, `warning` |
| Selection and fullscreen | `selectedBg`, `searchMatch*`, `scrollbar*` |
| Messages | `userMessage*`, `customMessage*`, `thinkingText` |
| Tool execution | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Status line | `statusBarBg` |
| Markdown | `md*` |
| Tool diffs | `toolDiff*` |
| Syntax highlighting | `syntax*` |
| Editor modes | `thinking*`, `bashMode` |
| HTML export | `export.pageBg`, `export.cardBg`, `export.infoBg` |

The schema is the format reference. The built-in themes provide complete values that you can copy and adjust.

Six colors are optional and inherit another color when omitted:

| Optional color | Fallback |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |
| `statusBarBg` | `toolPendingBg` |

If `export` colors are omitted, Fingers derives HTML page and panel backgrounds from `userMessageBg`.

## Load a theme from a project or package

Place a project theme in `.fingers/themes/`. Project themes load only after [project trust](security.md#understand-project-trust) is granted.

You can also load theme files and directories through the `themes` setting or distribute them in a Fingers package. See [Configuration](configuration.md), [Settings](settings.md#resources), and [Fingers Packages](packages.md).

Each loaded theme must have a unique name. Fingers reports duplicate names as resource collisions.
