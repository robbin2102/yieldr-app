def compute_skill_scores(traders: list[dict]) -> list[dict]:
    """
    Adds skill_score and skill_quartile (1=best, 4=worst) to each trader dict in-place.
    skill_score = rank(month_eff)*0.4 + rank(roi_ratio)*0.4 + rank(account_value)*0.2
    Ranks are normalised to [0, 1] across the cohort.
    Q1 = top 25% by skill_score (smart money).
    """
    n = len(traders)
    if n == 0:
        return traders

    def norm_ranks(key: str) -> list[float]:
        sorted_idxs = sorted(range(n), key=lambda i: traders[i].get(key, 0.0))
        ranks = [0.0] * n
        for rank, idx in enumerate(sorted_idxs):
            ranks[idx] = rank / (n - 1) if n > 1 else 0.0
        return ranks

    eff_rank = norm_ranks("month_eff")
    roi_rank = norm_ranks("roi_ratio")
    av_rank = norm_ranks("account_value")

    for i, t in enumerate(traders):
        t["skill_score"] = eff_rank[i] * 0.4 + roi_rank[i] * 0.4 + av_rank[i] * 0.2

    sorted_by_skill = sorted(range(n), key=lambda i: traders[i]["skill_score"], reverse=True)
    q_size = n / 4
    for rank, idx in enumerate(sorted_by_skill):
        traders[idx]["skill_quartile"] = min(4, int(rank / q_size) + 1)

    return traders
