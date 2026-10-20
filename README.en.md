# AE AI — AI-assisted motion graphics in Adobe After Effects

**Turn natural-language instructions into editable After Effects compositions.**

AE AI is an in-app conversational assistant connected to local After Effects tools. It helps creative teams inspect a project, build or modify scenes, organize layers and keyframes, and review visual results without leaving their editing environment.

[**Request a demonstration or discuss a pilot**](https://github.com/JuniorMM0110/after-effects-ai-agent/issues/new?template=solicitud-comercial.yml) · [Full feature guide (Spanish)](docs/FUNCIONALIDADES.md) · [Progress notes](AVANCES-AE-AI.md) · [Español](README.md)

## What it can do

- **Editable compositions:** work with layers, text, shapes, keyframes, expressions, effects, controllers and precompositions.
- **Scene-level automation:** inspect existing work, build scenes and apply coordinated modifications through high-level commands.
- **Reference-guided workflows:** attach image or video material for context while creating new work.
- **Review tools:** inspect frames and contact sheets, use sampled motion previews and flag potential issues for human review.
- **Conversational workflow:** reuse sessions, select AI models and reasoning options supported by the connected account, and view token usage information.
- **Inside After Effects:** CEP panel, local bridge and Model Context Protocol (MCP) integrations.

![AE AI visual review pipeline](demo/ae-ai-review-pipeline.png)

## Built for

Broadcast design teams, video production companies, creative studios, marketing agencies, professional motion designers and teams exploring AI-assisted production pipelines.

## Current stage and limitations

AE AI is **under active development**. It cannot guarantee fully autonomous broadcast-ready output. Animation quality, masks, 3D layouts and review results may still require manual correction. Short clips can now be rendered from every native composition frame and played at the source frame rate (with FFmpeg). This is **not live RAM Preview or continuous AI visual perception**, and heavy renders can be slow. The main test environment is After Effects 2026 on macOS Intel; packages are also prepared for macOS Apple Silicon and Windows x64, but cross-platform validation is still in progress.

AI model availability and usage limits depend on the user's supported Codex/ChatGPT connection; AE AI does not provide unlimited tokens. **Public pricing and a general-availability release date have not been announced.**

## Commercial interest

We welcome inquiries from studios, production companies and prospective partners regarding demos, pilots and collaboration. Use the [**commercial inquiry form**](https://github.com/JuniorMM0110/after-effects-ai-agent/issues/new?template=solicitud-comercial.yml) to describe your team and use case. Please do not post credentials or confidential client material in a public issue.

## Licensing

AE AI builds in part on MIT-licensed components from [Engine Room Games' After Effects MCP](https://github.com/Engine-Room-Games/after-effects-mcp). Existing MIT obligations and previously published versions remain subject to their applicable license. The current private builds and installers are not made available through this public showcase. See [Licensing and distribution (Spanish)](docs/LICENCIAS-Y-DISTRIBUCION.md).
