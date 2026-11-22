"""Run one agent task in a Phantom cloud browser, on Browsa's hosted model (no LLM key).

Cost: about 8 credits (browser 1 + task 1 + 1 per 5 steps + the hosted tier's 5 per task).
      Capped here at 10 with max_credits. A task that fails is not charged.

Run:
    pip install browsa
    BROWSA_API_KEY=agt_live_... python 01_run_task.py
"""
from browsa import Client


def main() -> None:
    client = Client()  # reads BROWSA_API_KEY
    job = client.run_task(
        task="Open https://news.ycombinator.com and return the title of the first story.",
        llm="browsa",        # hosted tier: no LLM key of your own
        max_steps=5,
        max_credits=10,      # the most this task may charge
        on_progress=lambda j: j.live_url and print("watch live:", j.live_url),
    )
    # status says the run ended; outcome says how it ended.
    print("status:", job.status, "| outcome:", job.outcome)
    print("result:", job.final_result)
    print("steps:", job.step_count, "| credits charged:", job.credits_charged)


if __name__ == "__main__":
    main()
