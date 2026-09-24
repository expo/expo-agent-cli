# devicectl fixtures

`list.json` is the shape of `xcrun devicectl list devices --json-output <file>`, trimmed to the fields `src/device/devicectl.ts` reads: a reachable iPhone with Developer Mode on, an unreachable iPad with it off, a paired iPhone whose tunnel is `disconnected` (unplugged or off Wi-Fi), a visionOS device, and a simulated device. Field names follow a real capture; the values are made up.
