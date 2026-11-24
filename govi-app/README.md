# Lights app (Govi replacement UI)

A single-file, mobile-first control app for smart lights, built around rooms,
one-tap power, a bottom sheet per light, and effects you apply to a room or to
everything. No build step and no dependencies.

Open `index.html` in a browser, or host the folder on any static server.

## Current state: demo mode

The app runs on sample rooms and lights, saved in the browser's localStorage.
It does **not** yet send commands to real Govi lights.

## Connecting real lights

All device control goes through `adapter.setLight(id, patch)` in `index.html`.
`patch` can contain `on`, `brightness` (1-100), `mode` (`color` or `white`),
`hue` (0-359), `sat` (0-100), `ct` (2200-6500 K) and `effect`.

To connect, replace the body of `adapter.setLight` with calls to your lights'
API or local network control. The UI does not need to change. Also replace
`seedState()` with a loader that reads your actual rooms and lights.

Before this works, we need to know how the Govi lights are controlled
(cloud account API, a Tuya-style local protocol, or something else).

## Effects

The effects in `seedState()` are placeholders. Rename them to match the effects
in the Govi app. Effects are currently applied as a static colour. Animated
effects need the device's own effect commands, so they go in the adapter.
