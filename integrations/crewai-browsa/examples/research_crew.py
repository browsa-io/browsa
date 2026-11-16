"""A research crew: one agent reads live pages with Browsa, another writes.

pip install crewai-browsa
export BROWSA_API_KEY=agt_live_...
# plus the key of the model your crew runs on, as usual in CrewAI
python research_crew.py
"""

from crewai import Agent, Crew, Process, Task

from crewai_browsa import BrowsaExtractTool, BrowsaScrapeTool, BrowsaTaskTool

scrape = BrowsaScrapeTool()  # 1 credit per page
extract = BrowsaExtractTool()  # 1 credit per page
browse = BrowsaTaskTool(max_steps=25)  # hosted tier "browsa" by default

researcher = Agent(
    role="Web researcher",
    goal="Collect accurate, current facts from the live web, with their source URLs",
    backstory=(
        "You read pages in a cloud browser. Read a known URL with the scrape tool; "
        "use the browser task tool only when you must click, search or page through a site."
    ),
    tools=[scrape, extract, browse],
)

writer = Agent(
    role="Analyst",
    goal="Turn the researcher's notes into a short, sourced brief",
    backstory="You write plainly and cite every fact with its URL.",
)

research = Task(
    description=(
        "Find what is on the front page of Hacker News right now: the top 5 stories "
        "with title, points and link. Then open the top story's link and summarise it "
        "in three sentences."
    ),
    expected_output="A list of 5 stories (title, points, URL) and a 3-sentence summary of the first.",
    agent=researcher,
)

brief = Task(
    description="Write a brief from the research: one line per story, then the summary.",
    expected_output="A Markdown brief with sources.",
    agent=writer,
    context=[research],
)

crew = Crew(agents=[researcher, writer], tasks=[research, brief], process=Process.sequential)

if __name__ == "__main__":
    print(crew.kickoff())
