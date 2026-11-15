"""5-line hello world. Copy, paste, set two env vars, run.

    export BROWSA_API_KEY=agt_live_...
    export ANTHROPIC_API_KEY=sk-ant-...   # optional: without it the task runs
                                          # on Browsa's hosted model (+5 credits)
    pip install browsa
    python quickstart.py
"""
import os
from browsa import Client

c = Client(api_key=os.environ["BROWSA_API_KEY"])
llm_key = os.environ.get("ANTHROPIC_API_KEY")
job = c.run_task(
    task="Go to https://news.ycombinator.com and return the title of the #1 story.",
    llm="claude-opus-5-5" if llm_key else "browsa",
    llm_api_key=llm_key,
    max_steps=5,
)
print("\n=== result ===\n", job.final_result)
print("\n=== live stream (was) ===\n", job.live_url)
print(f"\n=== steps ===  {job.step_count}/{job.progress_total}")
