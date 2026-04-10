# Pix Post Builder

This project includes a local frontend for creating fixed-style 9:16 news posts and a simple built-in scraper.

## What you can do

- Upload a main image
- Optionally upload a logo
- Enter a headline
- Download the post as a PNG
- Scrape a page URL and show deduplicated headline links inside the app

## Run the app

```powershell
cmd /c npm run start
```

Then open [http://localhost:3000](http://localhost:3000)

## Scraping

Use the `Web Scraper` section in the app:

- paste a page URL
- click `Start Scraping`
- view deduplicated results in the `Scraped output` panel
- click `Use as headline` to copy any scraped title into the post preview

## Notes

- The scraper is generic and works best on article listing pages with normal anchor tags.
- Some websites may block scraping or require JavaScript-heavy rendering.
- The dedupe step removes repeated title + URL pairs before showing results.