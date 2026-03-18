# Experiment Output Convention

Defines the directory structure and conventions for experiment outputs pushed from pod to GitHub. This document is a reference for the Neocortica main project — not implemented by neocortica-session.

## Directory Structure

```
<experiment-repo>/
├── checkpoints/    # Intermediate experiment state (model weights, training state)
├── results/        # Final experiment data (metrics, evaluations, artifacts)
└── reports/        # Analysis and summaries (written by pod CC)
```

## Rules

1. Pod CC commits and pushes outputs to the same branch used during deployment
2. Commit messages should be descriptive: `checkpoint: epoch 5, loss 0.23` or `result: final evaluation metrics`
3. Large binary files (model weights, datasets) should use Git LFS or be excluded — push only metadata and summaries
4. Reports should be human-readable markdown that local CC can digest

## Lifecycle

1. Pod CC writes outputs during experiment execution
2. Pod CC commits + pushes periodically (at checkpoints, on completion)
3. Local user triggers `session-return` skill to pull and digest
4. Local CC reads reports, updates its own MEMORY accordingly
