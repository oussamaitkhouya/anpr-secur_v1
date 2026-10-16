"""Small CRNN (CNN + bidirectional LSTM) trained with CTC loss for plate OCR.

Shape walk-through for the default 32x160 grayscale input (N = batch size):

    input            (N,   1, 32, 160)
    conv block 1  -> (N,  32, 16,  80)
    conv block 2  -> (N,  64,  8,  40)
    conv block 3  -> (N, 128,  4,  40)
    conv block 4  -> (N, 128,  2,  40)
    to sequence   -> (40, N, 256)      40 time steps, one per column strip
    BiLSTM        -> (40, N, 192)
    classifier    -> (40, N, num_classes) log-probabilities for CTCLoss

~0.5M parameters: trains on a CPU for smoke tests.
"""

import numpy as np
import torch
from PIL import Image
from torch import nn

from anpr.models.ocr_labels import Charset

IMG_HEIGHT = 32
IMG_WIDTH = 160  # plates are ~4.6:1; 160/32 = 5:1 keeps characters close to their real shape


def conv_block(c_in: int, c_out: int, pool: tuple[int, int]) -> nn.Sequential:
    return nn.Sequential(
        # 3x3 convolution with padding 1: learns local stroke/edge patterns, keeps height and width.
        nn.Conv2d(c_in, c_out, kernel_size=3, padding=1, bias=False),
        # Batch norm: rescales each channel to a stable range, so training converges faster
        # and is less sensitive to the learning rate. Replaces the conv bias, hence bias=False.
        nn.BatchNorm2d(c_out),
        # ReLU: the non-linearity that lets stacked convolutions model more than a linear filter.
        nn.ReLU(inplace=True),
        # Max pooling: downsamples by `pool` (height, width). Early blocks halve both;
        # later blocks halve height only, so enough columns (time steps) remain for CTC.
        nn.MaxPool2d(kernel_size=pool, stride=pool),
    )


class CRNN(nn.Module):
    def __init__(self, num_classes: int, img_height: int = IMG_HEIGHT, hidden: int = 96, dropout: float = 0.2):
        super().__init__()
        if img_height % 16:
            raise ValueError("img_height must be divisible by 16 (four poolings of height 2)")

        # Feature extractor: turns pixels into a grid of feature vectors.
        # Channels grow (1 -> 128) as spatial size shrinks, as in most CNNs.
        self.cnn = nn.Sequential(
            conv_block(1, 32, pool=(2, 2)),
            conv_block(32, 64, pool=(2, 2)),
            conv_block(64, 128, pool=(2, 1)),
            conv_block(128, 128, pool=(2, 1)),
        )
        feat_height = img_height // 16
        seq_features = 128 * feat_height  # each column strip flattened: channels x remaining height

        # Dropout: randomly zeroes features during training only, to reduce overfitting
        # to the synthetic font and layout.
        self.dropout = nn.Dropout(dropout)

        # Bidirectional LSTM: reads the column sequence left->right and right->left, so each
        # time step sees context on both sides (e.g. where one character ends and the next begins).
        # Output size is 2 * hidden because both directions are concatenated.
        self.rnn = nn.LSTM(seq_features, hidden, num_layers=1, bidirectional=True)

        # Classifier: per time step, a score for every character class plus the CTC blank.
        self.fc = nn.Linear(2 * hidden, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (N, 1, H, W) floats in [0, 1]. Returns (T, N, num_classes) log-probabilities."""
        f = self.cnn(x)                          # (N, C, h, T)
        n, c, h, t = f.shape
        f = f.permute(3, 0, 1, 2).reshape(t, n, c * h)  # one feature vector per column: (T, N, C*h)
        f, _ = self.rnn(self.dropout(f))         # (T, N, 2*hidden)
        logits = self.fc(self.dropout(f))        # (T, N, num_classes)
        # log_softmax: CTCLoss expects log-probabilities over classes at each time step.
        return logits.log_softmax(dim=2)


def preprocess(img: Image.Image, height: int = IMG_HEIGHT, width: int = IMG_WIDTH) -> torch.Tensor:
    """PIL image -> (1, H, W) float tensor in [0, 1]. Grayscale: colour carries no character info."""
    gray = img.convert("L").resize((width, height), Image.BILINEAR)
    return torch.from_numpy(np.asarray(gray, dtype=np.float32) / 255.0).unsqueeze(0)


@torch.no_grad()
def greedy_decode(log_probs: torch.Tensor, charset: Charset) -> list[str]:
    """(T, N, C) log-probabilities -> one string per batch item (CTC best path)."""
    best = log_probs.argmax(dim=2).T.cpu().tolist()  # (N, T) class ids
    return [charset.decode_greedy(ids) for ids in best]
