# async_zip

A fork of [`rs-async-zip`](https://github.com/Majored/rs-async-zip) intended for use in [uv](https://github.com/astral-sh/uv).

As compared to [`rs-async-zip`](https://github.com/Majored/rs-async-zip), this fork contains the following modifications:

- Support for streaming the central directory and end of central directory records.
- Support for tracking offsets during streamed reads.
- Support for accessing data descriptors during streamed reads.
- Stricter validation around extra field headers.
- Minor changes to better align with the Python ecosystem's `zipfile` module.
