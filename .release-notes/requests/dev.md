# Release request: dev

Documentation release builds now use the correct DOCS_SITE_URL and DOCS_BASE variables, eliminating doubled project paths such as /dbx-tools/dbx-tools. API generation runs two TypeDoc packages concurrently through the local binary in the generated site and up to five Python generators concurrently.
