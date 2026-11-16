# Salesforce Case Review Dashboard

A small browser-based dashboard for uploading Salesforce CSV exports. Select one or more `.csv` files or drag them onto the upload area. The files are read locally in your browser; they are not sent to a server.

## Run it

Open `index.html` in a modern browser, or publish the repository as a static GitHub Pages site. Use report-identifying filenames (for example, `Kora Stall Progressing.csv`, `Reserve Backlog.csv`, or `Claude Integrations.csv`) so the dashboard can apply the corresponding rules.

The report columns may vary between Salesforce exports. The dashboard recognizes common column names for owner, case number, latest update, install date, and scheduled date. If your export uses different headers, upload it first to confirm the file is accepted; the rules can then be mapped to its exact headers.

## Privacy

CSV parsing happens in the browser. The dashboard does not upload the selected files to a server.
