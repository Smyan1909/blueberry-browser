# Blueberry Browser

To really be able to compete with Strawberry, it was but obvious that blueberry should include a proprietary AI agent that can browse the web using Computer Use (Built from scratch).
But to give it a push further and make it superior we needed to add a feature that would greatly multiply productivity. Therefore we added a codegen sandbox using E2B to allow the agent to generate code to handle and modify files for the user. 

## Feature 1: Computer Use Agent

* **Perception**: The agent reads an indexed version of the DOM of the current page and along with Set-of-Mark prompting it understands the context of the page and what it can interact with.

* **Planning**: The agent plans its actions based on the user's request and the context of the page.

* **Action**: The agent uses tools that are activated through playwright and connected to blueberry via CDP to perform actions on the page like e.g. navigation, typing and clicking.

* **Monitoring**: The tab where the agent is active can be monitored by the user where the agent is given a ghost cursor to show where it is currently interacting with the page.

## Demo Video for Feature 1:



## Feature 2: Codegen Sandbox

* **Execution**: The agent is provided with a tool that allows it to execute python code in a sandboxed environment (E2B). The agent can use this tool to generate code to handle and modify files for the user.

* **Persistence**: The sandbox is not killed after execution to allow the agent to reuse it for multiple files.

* **Artifacts**: The agent can generate or modify the inputted files and return them to the user.


## Demo Video for Feature 2:



