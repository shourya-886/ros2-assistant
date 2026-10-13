# ROS2 Assistant

A VS Code extension for working with a running ROS 2 system without leaving the editor. Browse topics, services, actions and nodes from the sidebar, then echo topics, publish messages, call services, send action goals and manage `ros2 launch` sessions from dedicated panels.

The extension wraps the standard `ros2` command line tools, so it shows what the CLI would show, with templates, live output and buttons on top.

## Features

Open the **ROS2 Assistant** icon in the activity bar. The sidebar menu contains:

### List Topics
Lists the topics visible in the ROS graph (the list refreshes automatically). Click a topic to open a panel that streams `ros2 topic echo` live.

### Publish to Topic
Opens a publisher panel.

- Publish to an existing topic, or switch to **new topic** mode and give it a name starting with `/`.
- Message types are discovered from the installed ROS packages (`.msg` files under your `AMENT_PREFIX_PATH`), and picking one fills the message box with a YAML template for that type.
- Set the publish rate (Hz) and the number of messages, then start and stop publishing.
- Messages are published by a small `rclpy` node named `ros2_assistant_gui_publisher`. If the message has a `header.stamp` (or `stamp` and `frame_id`), it is filled with the current time.

### List Actions
Lists action servers. Click one to open a goal panel:

- The action type is detected and the goal box is pre-filled with a template built from the action definition (for example `order: 0` for Fibonacci).
- **Send Goal** runs `ros2 action send_goal --feedback` and streams the goal response, feedback messages and final result into one output box.
- **Cancel** stops the running goal client (it sends Ctrl+C, then force-kills after a short delay). Check your action server's log to see whether it also cancelled the goal.
- Only one goal runs per panel at a time.

### List Services
Lists services. Click one to open a call panel:

- The service type is detected and the request box is pre-filled with a template (for example `a: 0, b: 0` for `AddTwoInts`).
- **Call Service** shows a loading spinner and is disabled while the call runs, so it cannot be fired repeatedly.
- The response is shown as just its fields, for example `sum=3`.
- A call that gets no answer within 30 seconds is stopped with a hint to check the domain.

### List Nodes
Lists nodes. Click one to see the output of `ros2 node info` for it.

### Launch Manager
Opens a dashboard for `ros2 launch` (also available from the Command Palette as **ROS 2 Assistant: Open Launch Manager**).

- Discovers launch files in your open workspace: it scans `src/` for packages (folders with a `package.xml`) and lists `*.launch.py`, `*.launch.xml`, `*.launch.yaml` and `*.launch.yml` files from each package's `launch/` directory.
- Detects launch arguments and their defaults (via `ros2 launch <file> --show-args`) and shows them as editable fields. Empty fields are left out so the launch file's own defaults apply.
- Accepts extra arguments, one `name:=value` per line.
- Runs several launch sessions at once, each with status, and lets you stop any of them. A stop is a Ctrl+C that is escalated to a force kill after 5 seconds.
- Shows live terminal output per session, with auto-scroll and a clear button.
- Has a ROS 2 node list you can refresh. It shows all nodes in the ROS graph, not only the ones from a given launch session, because ROS 2 has no reliable way to map a node to the process that started it.
- If `<workspace>/install/setup.bash` exists, it is sourced before launching, so your built packages are found.

### Interface Explorer
Opens a read-only browser for the ROS 2 interface definitions installed on your machine (also available from the Command Palette as **ROS 2 Assistant: Open Interface Explorer**).

- Pick any message (`msg`), service (`srv`) or action (`action`) type from a drop-down. The list is built by scanning the packages in your `AMENT_PREFIX_PATH`, so it only needs the packages to be installed and sourced.
- The definition file is shown as plain text, so you can check the exact fields of a type before publishing, calling or sending a goal.
- **Refresh** rescans the installed packages. Like the other panels, it only sees the packages sourced by `/opt/ros/<distro>/setup.bash`.

## Requirements

- **Linux with bash.** The extension runs `bash` and looks for ROS in `/opt/ros`.
- **A ROS 2 installation at `/opt/ros/<distro>`**, where the distro is one of `humble`, `iron`, `jazzy`, `kilted`, `lyrical` or `rolling`. Older distros (for example Foxy or Galactic) are not supported.
- **VS Code 1.140 or newer** (the `engines` value in `package.json`).
- **`python3` with `rclpy`** (included in a normal ROS 2 install) for the publisher.
- **CycloneDDS**, unless you choose another RMW (see below): `sudo apt install ros-<distro>-rmw-cyclonedds-cpp`.

## First-run setup

When the extension starts it:

1. **Finds the installed ROS 2 distro** under `/opt/ros`. If `ROS_DISTRO` is already set in the VS Code process and is supported, that one is used. Otherwise the newest supported distro is used. If nothing supported is found, you get the message *"extension ROS2 Assistant is not compatible with the ros2 distro ..."* and the extension does not start.
2. **Asks for the `ROS_DOMAIN_ID`** (0 to 232). The box is pre-filled from the environment if it holds a valid value. The answer is stored by the extension, so you are only asked once. If you cancel, reload the window to be asked again.

Every command the extension runs then starts with `source /opt/ros/<distro>/setup.bash` and exports the chosen `ROS_DOMAIN_ID`.

### Matching your nodes (domain and RMW)

The extension only talks to nodes on the same domain and the same RMW implementation as its own commands.

- The domain must be the one your nodes use.
- The RMW is taken from `RMW_IMPLEMENTATION` in the environment VS Code was started with, if it is set. Otherwise it defaults to `rmw_cyclonedds_cpp`.
- Mixing RMW implementations (for example a Fast DDS client talking to a CycloneDDS server) fails in confusing ways, such as services receiving zeros or Fast DDS payload size errors. If your nodes use a different RMW, start VS Code from a terminal where `RMW_IMPLEMENTATION` is exported (`code .`), or make sure it is set for the desktop session.

## Usage

1. Start your ROS 2 nodes in a terminal that uses the same distro, domain and RMW.
2. Open the **ROS2 Assistant** sidebar and pick a menu entry. The back arrow in the view title returns to the menu.
3. Click an item in a list (topic, service, action or node) to open its panel.

For a quick test with the demo nodes:

```bash
ros2 run demo_nodes_py add_two_ints_server
```

Then open **List Services**, click `/add_two_ints`, enter `a: 1, b: 2` and press **Call Service**. The response is `sum=3`.

## Development

```bash
git clone https://github.com/shourya-886/ros2-assistant.git
cd ros2-assistant
npm install
```

Press **F5** in VS Code to start an Extension Development Host with the extension loaded. Stop the session completely and press F5 again to pick up changes (or run `npm run watch`).

- `npm run compile`: type-check, lint and bundle with esbuild
- `npm run watch`: rebuild on change
- `npm run check-types`: type-check only
- `npm run lint`: run ESLint
- `npm test`: compile and run the tests with `@vscode/test-cli`
- `npm run package`: production build (used by `vscode:prepublish`)

### Project layout

```
src/
  extension.ts            activation, sidebar tree, topic/publish/node/service/action panels
  core/
    rosEnvironment.ts     builds the ROS setup (distro, domain, RMW) shared by all commands
    processManager.ts     tracks child processes, status and output
  launch/
    launchManager.ts      launch file discovery, argument parsing, session handling
    launchDashboard.ts    Launch Manager webview
  interfaces/
    interfaceExplorer.ts  Interface Explorer webview and interface discovery
  test/                   tests for the backend, the launch manager and the interface explorer
```

## Known limitations

- Linux only. ROS must be installed under `/opt/ros`.
- There is no command yet to change the `ROS_DOMAIN_ID` after the first-run prompt.
- Apart from the Launch Manager, every panel sources only `/opt/ros/<distro>/setup.bash`. Message, service or action types that exist only in your own workspace are not found by those panels.
- The Launch Manager scans the `src/` folder of the folders open in VS Code, so open the workspace root that contains `src/`.

## Release notes

See [CHANGELOG.md](CHANGELOG.md).

## License

No license has been specified yet.