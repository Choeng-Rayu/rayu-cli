# Support

Thank you for using RAYU CLI! This document provides resources to help you get support.

## 📚 Documentation

Before asking for help, please check our documentation:

- **Official Docs:** https://rayu-web.vercel.app/docs
- **README.md:** [Getting started guide](README.md)
- **RAYU.md:** [CLI architecture and internals](rayu/RAYU.md)
- **AGENTS.md:** [AI agent instructions](rayu/AGENTS.md)

## 💬 Getting Help

### GitHub Discussions (Recommended)
For questions, ideas, and community support:
- [Ask a question](https://github.com/rayu-dev/rayu-cli/discussions/categories/q-a)
- [Share ideas](https://github.com/rayu-dev/rayu-cli/discussions/categories/ideas)
- [Show and tell](https://github.com/rayu-dev/rayu-cli/discussions/categories/show-and-tell)

### GitHub Issues
For bugs and feature requests:
- [Report a bug](https://github.com/rayu-dev/rayu-cli/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/rayu-dev/rayu-cli/issues/new?template=feature_request.md)

### Community Channels
- **Discord:** [Join our Discord server](#) (coming soon)
- **Twitter:** [@rayu_cli](#) (coming soon)
- **Email:** choengrayu307@gmail.com (for private inquiries)

## 🐛 Reporting Bugs

When reporting bugs, please include:
1. RAYU CLI version (`rayu --version`)
2. Operating system and version
3. Steps to reproduce
4. Expected vs actual behavior
5. Error messages or logs

See our [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md) for details.

## 🔒 Security Issues

**Do not report security vulnerabilities through public GitHub issues.**

Please see our [Security Policy](SECURITY.md) for instructions on reporting security vulnerabilities.

## 💡 Feature Requests

We welcome feature requests! Please:
1. Search existing issues to avoid duplicates
2. Clearly describe the problem and proposed solution
3. Explain why this would be valuable

See our [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md).

## 🤝 Contributing

Want to contribute? See our [Contributing Guide](CONTRIBUTING.md) for:
- Development setup instructions
- Coding standards
- Pull request process
- Testing requirements

## 📖 Additional Resources

### CLI Commands
```bash
rayu --help              # Show all commands
rayu /help               # Interactive help
rayu /model              # List available models
rayu /connect            # Configure provider
```

### Common Issues

#### Installation Issues
- Make sure you have Node.js 18+ or Bun 1.0+
- Try `npm install -g @rayu-dev/rayu-cli@latest`
- Check npm permissions if install fails

#### Connection Issues
- Verify your API keys are valid
- Check your internet connection
- Review provider status pages

#### Permission Issues
- RAYU uses a permission system to gate dangerous operations
- Review permission mode: `/config permission.mode`
- Check denied operations in the UI

### FAQ

**Q: Which AI providers are supported?**
A: Anthropic Claude, OpenAI, DeepSeek, Google Gemini, AWS Bedrock, and any OpenAI-compatible endpoint.

**Q: Is my API key secure?**
A: Keys are stored locally in `~/.rayu/config.json` with 600 permissions. They're never sent to RAYU servers (except when using rayu-gateway).

**Q: Can I use RAYU offline?**
A: RAYU requires internet for AI API calls, but works offline for local operations.

**Q: How much does RAYU cost?**
A: RAYU CLI is free and open source. You only pay for API usage to your chosen provider.

## 🏢 Enterprise Support

For enterprise support, training, or custom development:
- **Email:** [enterprise-email]
- **Website:** https://rayu-web.vercel.app/enterprise

## 📅 Response Times

- **Critical bugs:** 1-2 business days
- **Regular issues:** 3-5 business days
- **Feature requests:** Evaluated quarterly
- **Security issues:** 24-48 hours

## 🌟 Supporting the Project

If RAYU CLI has been helpful, consider:
- ⭐ Starring the repository
- 💬 Sharing with others
- 💙 [Sponsoring development](SPONSORS.md)
- 🤝 [Contributing code](CONTRIBUTING.md)

---

**Still need help?** Don't hesitate to reach out through any of the channels above!
