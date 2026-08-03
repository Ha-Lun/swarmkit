# Changelog

All notable changes to the opencode-config repository.

## [Unreleased]

### Added
- animation-specialist agent for 2D/3D web animation (Motion, GSAP, Anime.js, React Spring; Three.js, R3F, Drei) — model opencode-go/hy3 at temperature 0.3
- Task complexity classification and cost-aware routing in lead-dev
- Interactive install.sh with API key setup and existing config detection
- devops-specialist agent for CI/CD and IaC
- monitoring-specialist agent for observability stack
- feat: add MCP servers (shadcn, 21st-dev-magic, chrome-devtools) to opencode.jsonc
- feat: add `web-design-guidelines` skill (vendored from vercel-labs/agent-skills, MIT)

### Changed
- Consolidated config to single git repo with symlinks
- Updated all agent models to correct configurations
- Enhanced lead-dev with smart routing for cost optimization
- Simplified install.sh to focus on opencode-go and nvidia providers

### Fixed
- `linkedin-specialist` registered in `lead-dev.md` approved-subagents and routing tables, and in README install lists (it was added in a previous commit without registration)
- Removed duplicate node_modules and backup files
- Fixed absolute paths for portability
- Updated README with correct agent/skill counts
- fix: move gemini-mcp-tool from mcp.json (Claude format) into opencode.jsonc `mcp` key (opencode format) — was not actually being loaded

## [Initial Release]

### Added
- 17 specialized agents for different domains
- 15 custom skills
- Portable install script
- Consolidated config structure with symlinks
