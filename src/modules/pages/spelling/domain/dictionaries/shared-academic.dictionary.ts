/**
 * shared-academic.dictionary.ts
 * Pure domain shared academic, LaTeX, scientific, and engineering vocabulary for SpellEngine.
 */

const WORD_DATA = `
latex overleaf tex bibtex synctex manuscript manuscripts document section abstract introduction conclusion
acknowledgements references bibliography appendix equation figure table caption footnote citation citations author
authors journal conference proceedings volume issue pages publisher editor preface chapter subchapter thesis
dissertation proposal report review revision draft peer-review galley typeset typesetting preprint postprint
january february march april may june july august september october november december monday tuesday wednesday
thursday friday saturday sunday today date dated maketitle algorithm algorithms algorithmic architecture
architectures artificial intelligence machine learning deep neural network networks transformer transformers
attention attention-mechanism backpropagation gradient descent stochastic optimization optimizer regularization
overfitting underfitting hyperparameter hyperparameters tensor tensors matrix matrices vector vectors dimension
dimensional dimensionality feature features representation representations embedding embeddings convolutional
recurrent encoder decoder supervised unsupervised reinforcement dataset datasets benchmark benchmarks baseline
baselines accuracy precision recall f1-score loss convergence epoch epochs batch batches mini-batch iteration
iterations inference training validation testing cross-validation generalization classification regression
clustering segmentation detection generative adversarial diffusion database databases compiler compilers parser
parsers tokenizer tokenizers interpreter runtime framework library module package server client frontend backend
websocket socket cache buffer concurrency parallel distributed thread process mutex lock theorem theorems lemma
lemmas corollary corollaries proposition proof proofs conjecture axiom axioms definition definitions probability
probabilistic statistic statistics statistical distribution distributions gaussian normal binomial poisson variance
covariance expectation mean median mode standard deviation correlation hypothesis hypotheses null alternative
significance p-value eigenvalue eigenvalues eigenvector eigenvectors orthogonal orthonormal linear nonlinear convex
nonconvex concave differential derivative integral integrals asymptotic complexity polynomial exponential
logarithmic discrete continuous deterministic entropy stochasticity physics physical chemistry chemical biology
biological quantum mechanics thermodynamics optics particle atom atomic molecule molecular electron proton neutron
photon energy momentum velocity acceleration force gravity electromagnetic radiation frequency wavelength amplitude
spectrum resonance temperature pressure density viscosity equilibrium kinetics catalyst reaction synthesis compound
element polymer nanotechnology sensor the be to of and a in that have i it for not on with he as you do at this but
his by from they we say her she or an will my one all would there their what so up out if about who get which go me
when make can like time no just him know take people into year your good some could them see other than then now
look only come its over think also back after use two how our work first well way even new want because any these
give day most us great sample paper received shown shows present presents presented proposed proposes investigate
investigates investigated demonstrate demonstrates demonstrated evaluate evaluates evaluated compare compares
compared comparison comparative achieve achieves achieved outperform outperforms outperformed novel superior
effective efficient efficiency robust robustness scalable scalability method methods methodology approach
approaches technique techniques system systems model models modeling experimental experiments results discussion
analysis empirical theoretical findings future perspective perspectives limitation limitations context domain
application applications implement implements implemented implementation performance metric metrics score scores
observation observations derive derives derived formulate formulates formulated formulation assume assumes assumed
assumption assumptions denote denotes denoted let suppose given consider considering considered define defines
defined indicate indicates indicated suggest suggests suggested reveal reveals revealed confirm confirms confirmed
validate validates validated verify verifies verified exhibit exhibits exhibited illustrate illustrates illustrated
depict depicts depicted summarize summarizes summarized outline outlines outlined detail details detailed
specifically furthermore moreover however nevertheless consequently therefore thus hence accordingly respectively
similarly conversely importantly notably crucially substantially significantly marginally approximately roughly
primarily predominantly essentially fundamentally university universities institute institutes laboratory
laboratories department departments faculty student students professor professors researcher researchers scholar
scholars fellow fellowship grant grants funding collaborator collaborators collaboration project projects computer
computers screen keyboard device devices hardware software internet web page site platform service storage cloud
world country city state government society social human culture history historical language linguistic education
educational school study studies teaching knowledge skill ability practice theory concept idea thought view opinion
argument claim statement question answer problem solution topic subject field area scope range scale size amount
degree rate ratio percentage test tests tested line lines second third clean clear mistake mistakes error errors
correct correction check checks checked checking spelling spell word words string strings text texts file files
folder folders user users read write update delete create save load send receive contains contained containing
include included includes including exclude show case data datum info information point part step stage level value
set map list array number zero three four five six seven eight nine ten hundred thousand million billion simple
complex small large high low fast slow better best bad worse worst true false yes none every each both either
neither same different similar equal equivalent exact approximate rough fine main major minor key core root base
node tree graph path route source target input output param parameter function class type token symbol character
letter quote comment block code build run stop start end begin finish done fail pass success successful warn
warning debug trace log logger hello
`;

export const SHARED_DICTIONARY_WORDS: readonly string[] =
  WORD_DATA.trim().split(/\s+/);

export const ACADEMIC_SHARED_WORDS = SHARED_DICTIONARY_WORDS;
export const ACADEMIC_DICTIONARY_WORDS = SHARED_DICTIONARY_WORDS;
