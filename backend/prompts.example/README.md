# Placeholder prompts

The real prompts are deliberately not published (`prompts/` is gitignored). This directory carries
placeholders with the same interface so the test suite and CI can run against a clean checkout.

Copy it into place if you are working without the real prompts:

    cp -rn prompts.example/. prompts/

Nothing here is the production wording. Anything generated with these is a structural check only.
