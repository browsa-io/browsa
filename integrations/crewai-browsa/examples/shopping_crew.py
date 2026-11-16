"""A shopping-assistant crew: compare one product across several stores.

The shopper runs one Browsa browser task per store, each returning JSON
through an output schema, and the advisor compares the results. Browsa's
agent does not press order, payment or subscription buttons unless a task
sets allow_purchase, so this crew only reads.

    pip install crewai-browsa
    export BROWSA_API_KEY=agt_live_...
    # plus the key of the model your crew runs on, as usual in CrewAI
    python shopping_crew.py
"""

from crewai import Agent, Crew, Process, Task

from crewai_browsa import BrowsaTaskTool

OFFER_SCHEMA = {
    "type": "object",
    "properties": {
        "store": {"type": "string"},
        "product_title": {"type": "string"},
        "price": {"type": "number"},
        "currency": {"type": "string"},
        "in_stock": {"type": "boolean"},
        "url": {"type": "string"},
    },
    "required": ["store", "product_title", "price", "currency", "in_stock", "url"],
}

shop_task = BrowsaTaskTool(
    output_schema=OFFER_SCHEMA,  # every call returns this shape
    max_steps=30,
    max_credits=20,  # cap per store check
)

PRODUCT = "Sony WH-1000XM5 headphones, black"
STORES = ["bestbuy.com", "target.com", "walmart.com"]

shopper = Agent(
    role="Shopping assistant",
    goal="Find the current price and stock of one exact product at each store",
    backstory=(
        "You check one store per browser task. Make sure the listing is the exact "
        "product, not an accessory or a bundle. If a store has no listing, say so."
    ),
    tools=[shop_task],
)

advisor = Agent(
    role="Buying advisor",
    goal="Recommend where to buy, based only on the offers that were found",
    backstory="You compare like for like and never invent a price.",
)

find_offers = Task(
    description=(
        f"Product: {PRODUCT}. For each store in {STORES}, run one browser task: "
        "search the store for the product, open the exact listing and return the offer. "
        "Collect every offer and note any store that failed and why (use the tool's "
        "outcome_message)."
    ),
    expected_output="One JSON offer per store, plus a note for stores with no offer.",
    agent=shopper,
)

recommend = Task(
    description="Compare the offers: cheapest in-stock offer first, then the rest.",
    expected_output="A short table (store, price, in stock, link) and a one-line recommendation.",
    agent=advisor,
    context=[find_offers],
)

crew = Crew(agents=[shopper, advisor], tasks=[find_offers, recommend], process=Process.sequential)

if __name__ == "__main__":
    print(crew.kickoff())
