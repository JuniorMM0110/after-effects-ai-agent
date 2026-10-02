# AE AI — After Effects Agent Bridge

A portfolio fork and extension of [Engine Room Games' After Effects MCP](https://github.com/Engine-Room-Games/after-effects-mcp), focused on turning an MCP integration into a more complete AI-assisted workflow inside Adobe After Effects.

The project connects an LLM workflow to After Effects so the assistant can inspect a composition, reason about what should change, execute structured scene operations, and review the result instead of only returning instructions.

> This repository is based on the MIT-licensed Engine Room Games project. The original copyright and license are preserved. The **ae-astra-bridge** work extends that foundation with the features described below.

## What I added in this branch

- An **AE AI chat panel** inside After Effects with a compact conversational UI.
- Persistent **sessions and conversation context** for multi-step editing.
- Intent routing so normal questions stay conversational while composition requests can execute.
- High-level agent tools such as **inspect_scene**, **build_scene**, **modify_scene**, and **review_scene**.
- A **reference discovery workflow** that can surface and reuse visual/motion references.
- A visual review pipeline using composition snapshots and screenshots.
- Job progress, execution-state feedback, error handling, and bridge reconnection improvements.
- A motion-design knowledge layer with curated, learned, and synthesized techniques.
- Cross-platform setup and installer work for macOS and Windows.
- Expanded automated tests around the panel, bridge, installers, schemas, screenshots, and scene tools.

## Why this project exists

Traditional AI chat can tell an editor what to do. This project explores a different approach: give the model tools, scene context, and a feedback loop so it can act on a real creative application while keeping the result editable by the artist.

## Architecture

~~~text
LLM / Codex-style workflow
          |
          v
   AE AI CEP Panel
          |
          v
 Local MCP Server
   |           |
   |           +--> Motion knowledge / references
   |
   +--> HTTP + WebSocket bridge
                  |
                  v
          ExtendScript / JSX
                  |
                  v
          Adobe After Effects
                  |
                  +--> inspect / modify / screenshot / review
~~~

The system intentionally uses larger scene-level operations for agent workflows while preserving lower-level After Effects tools when more control is needed.

## Example visual review output

![AE AI review pipeline](demo/ae-ai-review-pipeline.png)

The review pipeline can capture multiple moments from a composition so the assistant can reason about animation state over time instead of judging a single frame.

## Technologies

- TypeScript / Node.js
- Model Context Protocol (MCP)
- Adobe CEP + ExtendScript / JSX
- HTTP and WebSocket bridge
- HTML, CSS, and JavaScript
- JSON-schema-based tool validation
- Automated Node.js test suites
- macOS and Windows packaging scripts

## Current validation

The current working version has been validated locally with:

~~~bash
npm test
npm run build
~~~

Both commands complete successfully on the development machine.

The test suite covers, among other areas:

- panel boot and UI behavior
- runtime/session behavior
- bridge timeout and port drift
- scene snapshots and screenshot integrity
- structured tool schemas
- write queues and job progress
- macOS and Windows installers
- motion knowledge generation
- CEP signatures and package layout

## Development setup

Requirements:

- Node.js 22+
- Adobe After Effects
- npm

Install dependencies:

~~~bash
npm install
~~~

Build the workspace:

~~~bash
npm run build
~~~

Run the tests:

~~~bash
npm test
~~~

For local macOS development, the workspace also includes setup and panel installation scripts:

~~~bash
npm run setup:mac
npm run install:panel
npm run doctor
~~~
## Repository structure

~~~text
packages/
  ae-panel/       After Effects CEP panel and AE AI interface
  mcp-server/     MCP server, bridge logic, tools, orchestration
  shared/         Shared schemas and types
  jsx/            After Effects ExtendScript operations

knowledge/        Motion-design knowledge and recipes
scripts/          Build, setup, packaging and release utilities
tests/unit/       Automated test suites
demo/             Visual examples
docs/             Architecture and subsystem notes
~~~

## Upstream foundation

The original project is **After Effects MCP** by Engine Room Games:

https://github.com/Engine-Room-Games/after-effects-mcp

It provides the core MCP-to-After-Effects foundation used by this fork. This branch is intended to demonstrate the additional agent workflow, UI, orchestration, knowledge, packaging, and reliability work built on top of that foundation.

## License

MIT License. See [LICENSE](LICENSE).

Original copyright remains with Engine Room as required by the upstream MIT license.
