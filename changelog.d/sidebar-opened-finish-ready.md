### Changed
- A finished agent you open in the web UI loses its DONE dot in the Agents list and its
  workspace row, as it does in herdr's own client; its next finish shows the dot again. The record
  is kept in each browser, so a finish opened on one device keeps its dot on another.
- A finish behind a drawer, popup viewer, Settings or another dialog keeps its dot, as does a
  hidden zoom target. The server identifies finishes after native-agent status overrides, so
  viewing a working pane does not acknowledge its later finish.
- Read records are scoped to each PC and server epoch, replaced on server startup or an observed
  herdr restart. Tabs save separate pane keys instead of overwriting a shared roster. Older PC
  bridges without finish identifiers keep their DONE dots until the bridge is updated.
