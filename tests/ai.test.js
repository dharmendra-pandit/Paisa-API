'use strict';

const { requestBody } = require('../src/services/ai.service');

const messages = [{ role: 'user', content: 'How much did I spend on food?' }];

describe('AI request body', () => {
  it('sends a classic chat model the parameters it has always had', () => {
    const body = requestBody(messages, { model: 'chat-model', maxOutputTokens: 800, reasoningEffort: null });

    expect(body).toEqual({
      model: 'chat-model',
      messages,
      stream: false,
      max_tokens: 800,
      temperature: 0.3,
    });
  });

  it('passes newer models their lowest effort, "none", straight through', () => {
    const body = requestBody(messages, { model: 'thinking-model', maxOutputTokens: 2000, reasoningEffort: 'none' });
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends a reasoning model only parameters it accepts', () => {
    const body = requestBody(messages, { model: 'thinking-model', maxOutputTokens: 2000, reasoningEffort: 'minimal' });

    // Reasoning models reject both of these outright, failing every question.
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).toMatchObject({
      model: 'thinking-model',
      messages,
      max_completion_tokens: 2000,
      reasoning_effort: 'minimal',
      verbosity: 'low',
    });
  });
});
