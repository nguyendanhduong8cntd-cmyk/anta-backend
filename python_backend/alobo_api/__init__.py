"""FastAPI implementation of the Alobo clone backend (incremental port)."""

import asyncio
import sys

# Psycopg async connections require SelectorEventLoop on Windows. Docker/Linux is unaffected.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
