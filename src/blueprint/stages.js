const fs = require('fs')
const path = require('path')

const STAGE_DOCUMENTS = {
  1: 'PROBLEM_STATEMENT.md',
  2: 'MARKET_SCOPE.md',
  3: 'VALUE_PROPOSITION.md',
  4: 'PRODUCT_OVERVIEW.md',
  5: 'MVP_SCOPE.md',
  6: 'USER_FLOWS.md',
  7: 'FRD.md',
  8: 'DOMAIN_SOURCE_OF_TRUTH.md',
  9: 'ENTITY_DEFINITIONS.md',
  10: 'STATE_MACHINE_SPEC.md',
  11: 'EVENT_MATRIX.md',
  12: 'ARCHITECTURE_PLAN.md',
  13: 'SERVICE_LAYER_SPEC.md',
  14: 'DB_SCHEMA.sql',
  15: 'BACKEND_IMPLEMENTATION_CONTRACT.md',
  16: 'TDD_TESTING_GUIDE.md',
  17: 'CONCURRENCY_AND_ATOMICITY_RULES.md',
  18: 'IMPLEMENTATION_PACK_CHECKLIST.md',
  19: 'SPEC_AUDITOR_AGENT.md',
}

const STAGE_NAMES = {
  1: 'Problem Definition',
  2: 'Market Scope',
  3: 'Value Proposition',
  4: 'Product Overview',
  5: 'MVP Scope',
  6: 'User Flows',
  7: 'Functional Requirements',
  8: 'Domain Model',
  9: 'Entity Definitions',
  10: 'State Machines',
  11: 'Event Matrix',
  12: 'Architecture Plan',
  13: 'Service Layer Specification',
  14: 'Database Schema',
  15: 'Backend Implementation Contract',
  16: 'Testing Strategy',
  17: 'Concurrency Rules',
  18: 'Implementation Pack',
  19: 'Audit Agent check',
}

// Parse stage-specific instructions from BLUEPRINT_BUILDER_AGENT.md
let _stageInstructions = null

function getStageInstructions() {
  if (_stageInstructions) return _stageInstructions

  const agentPath = path.join(__dirname, '../../BLUEPRINT_BUILDER_AGENT.md')
  const content = fs.readFileSync(agentPath, 'utf-8')

  _stageInstructions = {}
  const stageRegex = /# Stage (\d+) — .+\n([\s\S]*?)(?=\n# Stage \d+|\n# Completion|$)/g
  let match

  while ((match = stageRegex.exec(content)) !== null) {
    const num = parseInt(match[1])
    _stageInstructions[num] = match[2].trim()
  }

  return _stageInstructions
}

function getStage(num) {
  const instructions = getStageInstructions()
  return {
    num,
    name: STAGE_NAMES[num],
    document: STAGE_DOCUMENTS[num],
    instructions: instructions[num] || '',
  }
}

function getSpecAuditorPrompt() {
  const agentPath = path.join(__dirname, '../../SPEC_AUDITOR_AGENT.md')
  const content = fs.readFileSync(agentPath, 'utf-8')

  return content
}

module.exports = { getStage, STAGE_DOCUMENTS, STAGE_NAMES, TOTAL_STAGES: 19, getSpecAuditorPrompt }
