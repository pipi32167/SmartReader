# Changelog

## 1.0.9 - 2026-05-08

### Refactor
- Simplify PDF handling by always converting to Markdown before sending to AI
- Remove redundant OpenAI `file` content type upload logic
- Remove fallback to raw text extraction when API rejects file type

## 1.0.8 - 2026-05-07

### Documentation
- Update Chrome Web Store extension URL in README

## 1.0.5 - 2026-04-30

### Features
- Popup custom prompt now detects context status (webpage full text vs selected text)
- Add "include page content" checkbox for custom prompts (checked by default; uncheck to send prompt only)
- History detail page adds "view full prompt" modal for reading complete prompt text

## 1.0.4 - 2026-04-28

### Features
- Cache custom prompt input in popup and restore on reopen

### Documentation
- Add README in English and Chinese

## 1.0.3 - 2026-04-27

### Features
- Add history search functionality
- Support deleting individual messages from conversation history
- Add retry button for regenerating AI responses

## 1.0.2 - 2026-04-26

### Features
- Add conversation history with SQLite persistence
- Support multi-turn follow-up conversations
- Add PDF text extraction fallback for APIs without file upload support

## 1.0.1 - 2026-04-25

### Features
- Initial release with webpage content extraction and AI summarization
- Support custom prompt templates with ${html} and ${text} variables
- Stream AI responses in side panel
- Options page for API configuration and prompt management
