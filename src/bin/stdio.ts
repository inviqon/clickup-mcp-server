#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../core/config.js'
import { createContext } from '../core/context.js'
import { ALL_TOOLS } from '../tools/index.js'
import { buildServer } from '../server.js'

const config = loadConfig(process.env)
const context = createContext(config)
const server = buildServer({ tools: ALL_TOOLS, config, contextFactory: () => context })
await server.connect(new StdioServerTransport())
console.error(`clickup-mcp ready: mode=${config.mode}`)
