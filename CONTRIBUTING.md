# Contributing to DBison

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- the DBison version (Help ▸ About DBison) and your operating system;
- the database engine and version you were connected to;
- what you did, what you expected and what happened instead;
- anything relevant from the log file (Help ▸ Open Log Folder). Remove host
  names and anything else private first.

Please report security problems privately instead. See [SECURITY.md](SECURITY.md).

## Suggesting a feature

Open an issue that describes the problem you want solved before you write a
large change. That way we can agree on the approach first, and your work is
less likely to be wasted.

## Pull requests

1. Fork the repository and branch from `main`.
2. Set up and run the app as the [README](README.md#develop) describes.
3. Keep the change focused on one thing, and match the style of the code around
   it.
4. Make sure `npm run lint`, `npm run typecheck` and `npm test` pass. If you
   touched the UI or a driver, run the relevant smoke script as well (see
   [Smoke tests](README.md#smoke-tests)).
5. Open the pull request and describe what changed and why.

### Contributor Licence Agreement

The first time you open a pull request, a bot will ask you to sign the
[Contributor Licence Agreement](CLA.md). You sign it by posting the comment the
bot asks for, and you only do it once.

In short: you keep the copyright in your work, your contribution stays
available under the AGPL-3.0, and you allow the maintainer to also license it
under other terms, such as a commercial licence. That dual licensing is how
DBison can stay open source and still pay for its own development. The
[CLA](CLA.md) itself is the binding text.

## Licence

By contributing, you agree that your contributions are licensed under the
[GNU Affero General Public License v3.0](LICENSE) and under the terms of the
[CLA](CLA.md).
